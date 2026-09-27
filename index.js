require('dotenv').config();

const {
  Client,
  GatewayIntentBits,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
  ChannelSelectMenuBuilder,
  RoleSelectMenuBuilder,
  UserSelectMenuBuilder,
  ChannelType,
  EmbedBuilder,
  Events,
  PermissionFlagsBits,
  SlashCommandBuilder,
  REST,
  Routes,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  AttachmentBuilder
} = require('discord.js');

const fs = require('fs');
const path = require('path');
const express = require('express');
const { MongoClient } = require('mongodb');

// Dependência extra necessária para gerar o QR Code do Pix (Liberar Chave).
// Adicione "qrcode" ao package.json e rode: npm install qrcode
const QRCode = require('qrcode');

// ==========================================
// CLIENT DO DISCORD
// ==========================================

// ATENÇÃO: MessageContent e GuildMembers são intents privilegiados. Ative "Message Content
// Intent" E "Server Members Intent" em Discord Developer Portal > seu app > Bot > Privileged
// Gateway Intents (senão o bot não liga, ou trava com erro ao buscar membros do servidor,
// por exemplo ao abrir tickets e adicionar a staff automaticamente).
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers
  ]
});

// ==========================================
// BANCO DE DADOS (MONGODB)
// Interface: db.get(chave), db.set(chave, valor), db.delete(chave), db.keys()
// Defina a variável de ambiente MONGODB_URI (string de conexão do Atlas/Render)
// e, opcionalmente, MONGODB_DB (nome do banco, padrão "botfila").
// Tudo (filas, perfis, vitórias, derrotas, coins, .p, configs, etc.) é salvo
// numa collection de chave/valor chamada "kv".
// ==========================================

if (!process.env.MONGODB_URI) {
  console.error('❌ Variável de ambiente MONGODB_URI não definida. Configure a connection string do MongoDB.');
  process.exit(1);
}

const mongoClient = new MongoClient(process.env.MONGODB_URI);
let kvCollection = null;

async function conectarMongo() {
  await mongoClient.connect();
  const dbMongo = mongoClient.db(process.env.MONGODB_DB || 'botfila');
  kvCollection = dbMongo.collection('kv');
  await kvCollection.createIndex({ chave: 1 }, { unique: true });
  console.log('✅ Conectado ao MongoDB.');
}

function clonar(valor) {
  return valor === undefined ? undefined : JSON.parse(JSON.stringify(valor));
}

const db = {
  async get(chave) {
    const doc = await kvCollection.findOne({ chave });
    return doc ? clonar(doc.valor) : undefined;
  },
  async set(chave, valor) {
    await kvCollection.updateOne(
      { chave },
      { $set: { chave, valor: clonar(valor) } },
      { upsert: true }
    );
    return valor;
  },
  async delete(chave) {
    await kvCollection.deleteOne({ chave });
  },
  async keys() {
    const docs = await kvCollection.find({}, { projection: { chave: 1 } }).toArray();
    return docs.map(d => d.chave);
  }
};

// ==========================================
// TRAVA POR CHAVE
// Só uma rotina por vez mexe no mesmo registro. Evita perder dados quando
// 2 jogadores clicam ao mesmo tempo (ex.: os dois confirmando a aposta).
// ==========================================

const travas = new Map();

async function comTrava(chave, fn) {
  const anterior = travas.get(chave) || Promise.resolve();
  let liberar;
  const minha = new Promise(resolve => { liberar = resolve; });
  const fila = anterior.then(() => minha);
  travas.set(chave, fila);

  await anterior;
  try {
    return await fn();
  } finally {
    liberar();
    if (travas.get(chave) === fila) travas.delete(chave);
  }
}

// ==========================================
// SERVIDOR WEB (o Render exige uma porta aberta)
// ==========================================

const app = express();

const PORT = process.env.PORT || 10000;

app.get('/', (req, res) => {
  res.status(200).send('🤖 Bot de filas online!');
});

app.listen(PORT, () => {
  console.log(`Servidor web ouvindo na porta ${PORT}`);
});

// ==========================================
// FUNÇÕES AUXILIARES DE FORMATAÇÃO E CÁLCULO
// ==========================================

function formatarValorVisual(valor) {
  if (valor === undefined || valor === null || isNaN(valor)) return '0,00';
  let num = typeof valor === 'number' ? valor : parseFloat(String(valor).replace(',', '.'));
  if (isNaN(num)) return '0,00';
  return num.toFixed(2).replace('.', ',');
}

function paraCentavos(valor) {
  if (valor === undefined || valor === null) return 0;
  let num = typeof valor === 'number' ? valor : parseFloat(String(valor).replace(',', '.'));
  if (isNaN(num)) return 0;
  return Math.round(num * 100);
}

function deCentavos(centavos) {
  if (centavos === undefined || centavos === null || isNaN(centavos)) return 0;
  return centavos / 100;
}

async function calcularValorComTaxaVirtual(valorBaseReais) {
  const taxaConfig = await db.get('config_taxa_org');
  let taxaReais = 0;
  if (taxaConfig !== undefined && taxaConfig !== null) {
    taxaReais = typeof taxaConfig === 'number' ? taxaConfig : parseFloat(String(taxaConfig).replace(',', '.'));
    if (isNaN(taxaReais)) taxaReais = 0;
  }
  const total = valorBaseReais + taxaReais;
  return formatarValorVisual(total);
}

function montarTituloFila(modalidade, valorReais) {
  const modFormatada = String(modalidade || 'MODALIDADE').toUpperCase();
  const valorFormatado = formatarValorVisual(valorReais);
  return `${modFormatada} | ${valorFormatado}`;
}

function criarEmbedFila(modalidade, valorReais, jogadores = [], fotoUrl = null, imagemUrl = null) {
  const titulo = montarTituloFila(modalidade, valorReais);

  let listaJogadores = 'Nenhum jogador na fila';
  if (jogadores && jogadores.length > 0) {
    listaJogadores = jogadores.map(j => {
      const uid = j.id || j;
      return j.regra ? `<@${uid}> | ${j.regra}` : `<@${uid}>`;
    }).join('\n');
  }

  const embed = new EmbedBuilder()
    .setTitle(titulo)
    .setColor('#FF0000')
    .addFields({ name: 'Jogadores', value: listaJogadores, inline: false });

  if (fotoUrl) embed.setThumbnail(fotoUrl);
  if (imagemUrl) embed.setImage(imagemUrl);

  return embed;
}

// ==========================================
// PIX: GERAÇÃO DE PAYLOAD (BR CODE) E QR CODE
// Usado no botão "Liberar Chave": monta um QR Code Pix válido a partir da chave, do nome
// do titular e do valor a pagar, e anexa a imagem na mesma mensagem.
// ==========================================

function removerAcentos(txt) {
  return String(txt || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

function crc16ccitt(payload) {
  let crc = 0xFFFF;
  for (let i = 0; i < payload.length; i++) {
    crc ^= payload.charCodeAt(i) << 8;
    for (let j = 0; j < 8; j++) {
      if ((crc & 0x8000) !== 0) {
        crc = (crc << 1) ^ 0x1021;
      } else {
        crc <<= 1;
      }
      crc &= 0xFFFF;
    }
  }
  return crc.toString(16).toUpperCase().padStart(4, '0');
}

function emvField(id, value) {
  const len = String(value.length).padStart(2, '0');
  return `${id}${len}${value}`;
}

function gerarPayloadPix({ chave, nome, cidade, valor, txid }) {
  const nomeLimpo = removerAcentos(nome).toUpperCase().replace(/[^A-Z0-9 ]/g, '').slice(0, 25) || 'RECEBEDOR';
  const cidadeLimpa = removerAcentos(cidade || 'BRASIL').toUpperCase().replace(/[^A-Z0-9 ]/g, '').slice(0, 15) || 'BRASIL';
  const txidLimpo = String(txid || '***').replace(/[^a-zA-Z0-9]/g, '').slice(0, 25) || '***';

  const gui = emvField('00', 'br.gov.bcb.pix');
  const chaveField = emvField('01', String(chave));
  const merchantAccountInfo = emvField('26', gui + chaveField);

  const merchantCategoryCode = emvField('52', '0000');
  const transactionCurrency = emvField('53', '986');

  let valorField = '';
  const valorNum = parseFloat(valor);
  if (valorNum && valorNum > 0) {
    valorField = emvField('54', valorNum.toFixed(2));
  }

  const countryCode = emvField('58', 'BR');
  const merchantName = emvField('59', nomeLimpo);
  const merchantCity = emvField('60', cidadeLimpa);
  const additionalData = emvField('62', emvField('05', txidLimpo));

  const payloadSemCrc =
    emvField('00', '01') +
    merchantAccountInfo +
    merchantCategoryCode +
    transactionCurrency +
    valorField +
    countryCode +
    merchantName +
    merchantCity +
    additionalData +
    '6304';

  const crc = crc16ccitt(payloadSemCrc);
  return payloadSemCrc + crc;
}

async function gerarQrCodePixBuffer(pix, valorReais) {
  try {
    if (!pix || !pix.chave) return null;
    const payload = gerarPayloadPix({
      chave: pix.chave,
      nome: pix.titular,
      cidade: 'BRASIL',
      valor: valorReais
    });
    return await QRCode.toBuffer(payload, { width: 400, margin: 1 });
  } catch (e) {
    console.error('Erro ao gerar QR Code Pix:', e);
    return null;
  }
}

// ==========================================
// AUXILIARES DE CONFIGURAÇÃO E PERMISSÕES
// ==========================================

// Resolve a foto configurada. Se for "org", usa o ícone do servidor.
async function resolverFoto(guild) {
  const foto = await db.get('config_foto');
  if (!foto) return null;
  if (String(foto).toLowerCase() === 'org') {
    return guild ? guild.iconURL({ size: 512 }) : null;
  }
  return foto;
}

function membroTemAlgumCargo(member, cargoIds) {
  if (!member || !cargoIds || cargoIds.length === 0) return false;
  const roles = member.roles;
  if (Array.isArray(roles)) return roles.some(id => cargoIds.includes(id));
  if (roles && roles.cache) return roles.cache.some(r => cargoIds.includes(r.id));
  return false;
}

async function verificarCargoMediador(member) {
  const cargos = (await db.get('config_cargo_mediador')) || [];
  if (cargos.length === 0) return { ok: false, motivo: 'nao_configurado' };
  if (!membroTemAlgumCargo(member, cargos)) return { ok: false, motivo: 'sem_cargo' };
  return { ok: true };
}

async function ehAdmin(interaction) {
  if (interaction.memberPermissions && interaction.memberPermissions.has(PermissionFlagsBits.Administrator)) {
    return true;
  }
  const cargosAdmin = (await db.get('config_select_role_cargos')) || [];
  return membroTemAlgumCargo(interaction.member, cargosAdmin);
}

// Mesma checagem de admin, mas para comandos por mensagem (.d), que não têm memberPermissions
async function ehAdminMensagem(message) {
  if (message.member && message.member.permissions.has(PermissionFlagsBits.Administrator)) return true;
  const cargosAdmin = (await db.get('config_select_role_cargos')) || [];
  return membroTemAlgumCargo(message.member, cargosAdmin);
}

// Quem pode gerenciar tickets (finalizar, assumir, painel staff): administradores, cargos
// administrativos (mesmos de /configbot > Cargos) ou os cargos definidos em /configticket > Cargo Staff
async function ehStaffTicket(member, guild) {
  if (!member) return false;
  if (member.permissions && member.permissions.has && member.permissions.has(PermissionFlagsBits.Administrator)) return true;
  const cargosTicket = (await db.get('config_ticket_staff_cargos')) || [];
  if (membroTemAlgumCargo(member, cargosTicket)) return true;
  const cargosAdmin = (await db.get('config_select_role_cargos')) || [];
  return membroTemAlgumCargo(member, cargosAdmin);
}

// ==========================================
// PERSONALIZAÇÃO: COR, EMOJIS E EMBEDS (.d / /embed)
// Tudo é lido/gravado direto no MongoDB (chaves config_cor_hex, config_emojis, config_embeds)
// ==========================================

// Cor usada em toda embed do bot: a cor da org (/configbot > Cor da Org) se estiver definida,
// senão vermelho.
async function corPadrao() {
  const cor = await db.get('config_cor_hex');
  return (cor && /^#([0-9A-F]{3}){1,2}$/i.test(cor)) ? cor : '#FF0000';
}

// Registro dos botões cujo emoji pode ser trocado pelo painel de personalização (.d > Emojis).
// Aceita tanto emojis padrão (unicode) quanto emojis personalizados do servidor: basta abrir o
// seletor de emojis do próprio Discord dentro do campo do formulário e escolher o emoji do server,
// o texto <:nome:id> (ou <a:nome:id> se for animado) é salvo do jeito que o Discord entende.
const EMOJIS_EDITAVEIS = {
  entrar_normal: { label: 'Botão "Normal" (fila)', padrao: '🎮' },
  entrar_ump: { label: 'Botão "Full UMP e XM8" (fila)', padrao: '🔥' },
  entrar_gelo_normal: { label: 'Botão "Gelo Normal" (fila 1x1)', padrao: '🎮' },
  entrar_gelo_infinito: { label: 'Botão "Gelo Infinito" (fila 1x1)', padrao: '♾️' },
  entrar_emu: { label: 'Botões "N Emu" (fila Misto)', padrao: '🖥️' },
  sair_fila: { label: 'Botão "Sair" (fila)', padrao: '❌' },
  filamed_entrar: { label: 'Botão "Entrar" (fila de mediadores)', padrao: '' },
  filamed_sair: { label: 'Botão "Sair" (fila de mediadores)', padrao: '' },
  filamed_rank: { label: 'Botão "Rank" (fila de mediadores)', padrao: '' },
  filamed_config: { label: 'Botão de configuração (fila de mediadores)', padrao: '⚙️' },
  cadastromed_cadastrar: { label: 'Botão "Cadastrar Chave" (cadastro de mediadores)', padrao: '⚙️' },
  cadastromed_verificar: { label: 'Botão "Verificar Chave" (cadastro de mediadores)', padrao: '🔍' },
  cadastromed_verificar_adm: { label: 'Botão "Verificar ADM" (cadastro de mediadores)', padrao: '✅' },
  partida_confirmar: { label: 'Botão "Confirmar" (partida)', padrao: '✅' },
  partida_cancelar: { label: 'Botão "Cancelar" (partida)', padrao: '❌' },
  liberar_chave: { label: 'Botão "Liberar Chave" (partida)', padrao: '💠' },
  streamer_jogar: { label: 'Botão "Jogar" (fila contra streamer)', padrao: '' },
  streamer_sair: { label: 'Botão "Sair" (fila contra streamer)', padrao: '' },
  streamerpainel_regras: { label: 'Botão "Regras" (painel do streamer)', padrao: '📝' },
  streamerpainel_puxar: { label: 'Botão "Puxar Jogador" (painel do streamer)', padrao: '🎯' },
  streamerpainel_modo: { label: 'Botão "Definir Modo" (painel do streamer)', padrao: '🎮' },
  streamerpainel_remover: { label: 'Botão "Remover Jogadores" (painel do streamer)', padrao: '👥' },
  ticket_finalizar: { label: 'Botão "Finalizar Ticket"', padrao: '✅' },
  ticket_assumir: { label: 'Botão "Assumir Ticket"', padrao: '🛠️' },
  ticket_painel_staff: { label: 'Botão "Painel Staff"', padrao: '🛡️' },
  ticket_sair: { label: 'Botão "Sair Ticket"', padrao: '✏️' },
  sala_copiar_id: { label: 'Botão "Copiar ID" (sala criada)', padrao: '🆔' },
  sala_alterar_valor: { label: 'Botão "Alterar Valor" (sala criada)', padrao: '✏️' }
};

async function obterEmoji(chave, padrao) {
  const emojis = (await db.get('config_emojis')) || {};
  const salvo = emojis[chave];
  return (salvo && String(salvo).trim()) ? salvo : padrao;
}

// Registro das embeds (título + descrição) editáveis pelo painel de personalização (.d > Embed).
// O painel de Tickets já tem seu próprio editor de nome/descrição em /configticket, por isso
// não entra aqui (para não ter 2 lugares diferentes editando a mesma coisa).
const EMBEDS_EDITAVEIS = {
  ranking_painel: {
    label: 'Painel de Perfil e Ranking (/ranking)',
    tituloPadrao: '📊 Perfil e Ranking',
    descricaoPadrao: 'Seja bem-vindo(a) ao painel de perfil e ranking do servidor!\n\nVeja o perfil e o ranking atual do servidor através dos botões abaixo.'
  },
  cadastromed_painel: {
    label: 'Painel de Cadastro de Chave PIX (/cadastromed)',
    tituloPadrao: '💠 Configurar Chave PIX',
    descricaoPadrao: '↪️ Sistema de automatização de pagamentos! 💲\n\nConfigure sua chave PIX uma vez.\n\nEla será enviada automaticamente em todas as salas criadas 📋'
  }
};

async function obterTextoEmbed(chave) {
  const cfg = EMBEDS_EDITAVEIS[chave];
  const salvos = (await db.get('config_embeds')) || {};
  const meu = salvos[chave] || {};
  return {
    titulo: meu.titulo || cfg.tituloPadrao,
    descricao: meu.descricao || cfg.descricaoPadrao
  };
}

function montarPainelPersonalizacao() {
  const embed = new EmbedBuilder()
    .setTitle('🎨 Personalização do Bot')
    .setDescription('Escolha o que deseja personalizar:\n\n**Emojis** — troca o emoji de qualquer botão do bot (aceita emojis do servidor).\n**Embed** — edita o título e a descrição de algumas embeds do bot.')
    .setColor('#0044FF');

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('personalizar_emojis').setLabel('Emojis').setStyle(ButtonStyle.Primary).setEmoji('😀'),
    new ButtonBuilder().setCustomId('personalizar_embed').setLabel('Embed').setStyle(ButtonStyle.Primary).setEmoji('🖼️')
  );

  return { embeds: [embed], components: [row] };
}

// O Discord só permite 25 opções por select menu: se a lista crescer além disso, divide em várias
function montarSelectsEmojis() {
  const entradas = Object.entries(EMOJIS_EDITAVEIS);
  const linhas = [];
  for (let i = 0; i < entradas.length; i += 25) {
    const pagina = entradas.slice(i, i + 25);
    const select = new StringSelectMenuBuilder()
      .setCustomId(`select_personalizar_emoji_${Math.floor(i / 25)}`)
      .setPlaceholder(`Selecione o botão (${i + 1}-${i + pagina.length})`)
      .addOptions(pagina.map(([chave, cfg]) => ({ label: cfg.label.slice(0, 100), value: chave })));
    linhas.push(new ActionRowBuilder().addComponents(select));
  }
  return linhas;
}

function montarSelectEmbeds() {
  const select = new StringSelectMenuBuilder()
    .setCustomId('select_personalizar_embed')
    .setPlaceholder('Selecione a embed que deseja editar')
    .addOptions(Object.entries(EMBEDS_EDITAVEIS).map(([chave, cfg]) => ({
      label: cfg.label.slice(0, 100),
      value: chave
    })));
  return new ActionRowBuilder().addComponents(select);
}

// ==========================================
// CONSTRUTOR DE EMBED PERSONALIZADA (/embed)
// Rascunho fica em memória por usuário enquanto ele monta a embed (título, descrição, cor,
// imagem, thumbnail) e some quando ele publica ou fecha o painel. A descrição aceita, do jeito
// que o usuário digitar: emojis do servidor (<:nome:id>), "# " para títulos maiores dentro da
// embed e menções de pessoas/canais (@usuário, #canal) — tudo isso é só texto puro, então o
// próprio Discord já renderiza certo, sem precisar de nenhum tratamento especial aqui.
// ==========================================

const rascunhosEmbed = new Map();

function obterRascunhoEmbed(userId) {
  if (!rascunhosEmbed.has(userId)) {
    rascunhosEmbed.set(userId, { titulo: null, descricao: null, cor: null, imagem: null, thumbnail: null });
  }
  return rascunhosEmbed.get(userId);
}

function montarPainelEmbedCustom(userId) {
  const rascunho = obterRascunhoEmbed(userId);

  const preview = new EmbedBuilder().setColor(rascunho.cor || '#FF0000');
  if (rascunho.titulo) preview.setTitle(rascunho.titulo);
  preview.setDescription(rascunho.descricao || '*Nenhuma descrição definida ainda. Use os botões abaixo para configurar a embed.*');
  if (rascunho.imagem) preview.setImage(rascunho.imagem);
  if (rascunho.thumbnail) preview.setThumbnail(rascunho.thumbnail);

  const row1 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('embedcustom_titulo').setLabel('Título').setStyle(ButtonStyle.Primary).setEmoji('📝'),
    new ButtonBuilder().setCustomId('embedcustom_descricao').setLabel('Descrição').setStyle(ButtonStyle.Primary).setEmoji('📄'),
    new ButtonBuilder().setCustomId('embedcustom_cor').setLabel('Cor').setStyle(ButtonStyle.Primary).setEmoji('🎨')
  );
  const row2 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('embedcustom_imagem').setLabel('Imagem').setStyle(ButtonStyle.Secondary).setEmoji('🌄'),
    new ButtonBuilder().setCustomId('embedcustom_thumbnail').setLabel('Thumbnail').setStyle(ButtonStyle.Secondary).setEmoji('🖼️'),
    new ButtonBuilder().setCustomId('embedcustom_limpar').setLabel('Limpar Tudo').setStyle(ButtonStyle.Danger).setEmoji('🗑️')
  );
  const row3 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('embedcustom_publicar').setLabel('Publicar Aqui').setStyle(ButtonStyle.Success).setEmoji('✅')
  );

  return {
    content: '🖼️ **Construtor de Embed** — configure abaixo, a prévia atualiza em tempo real:',
    embeds: [preview],
    components: [row1, row2, row3]
  };
}

// ==========================================
// GERENCIAMENTO DA FILA FIFO DE MEDIADORES
// ==========================================

async function obterProximoMediador() {
  const filaMediadores = (await db.get('fila_mediadores_fifo')) || [];
  if (filaMediadores.length === 0) return null;
  return filaMediadores[0];
}

// Pega o 1º mediador da fila e já joga ele para o último lugar (rodízio), tudo de uma vez
async function pegarMediadorEGirar() {
  return comTrava('mediadores', async () => {
    const fila = (await db.get('fila_mediadores_fifo')) || [];
    if (fila.length === 0) return null;
    const mediadorId = fila[0];
    await db.set('fila_mediadores_fifo', [...fila.slice(1), mediadorId]);
    return mediadorId;
  });
}

// Número sequencial da partida (1, 2, 3, 4...), salvo para sempre no Mongo
async function proximoNumeroPartida() {
  return comTrava('contador_partidas', async () => {
    const atual = (await db.get('contador_partidas')) || 0;
    const proximo = atual + 1;
    await db.set('contador_partidas', proximo);
    return proximo;
  });
}

// Depois que um mediador entra, monta as partidas que estavam esperando por ele
async function processarFilasPendentes() {
  const chaves = await db.keys();
  for (const chave of chaves) {
    if (!/^fila_\d+$/.test(chave)) continue;
    try {
      await verificarEMatchmaking(chave.replace('fila_', ''));
    } catch (e) {
      console.error('Erro ao processar fila pendente:', e);
    }
  }
}

// ==========================================
// PAINÉIS DE MEDIADORES (/filamed e /cadastromed)
// ==========================================

async function montarPainelFilaMed(guild) {
  const fila = (await db.get('fila_mediadores_fifo')) || [];
  const lista = fila.length > 0
    ? fila.map((id, i) => `${i + 1}º - <@${id}>`).join('\n')
    : 'Nenhum mediador em serviço no momento.';

  const embed = new EmbedBuilder()
    .setTitle('Mediadores em Serviço')
    .setDescription(`${lista}\n\n**Aguarde ser chamado por um Jogador.**`)
    .setColor('#0044FF');

  const icone = guild ? guild.iconURL({ size: 512 }) : null;
  if (icone) embed.setThumbnail(icone);

  const emojiEntrar = await obterEmoji('filamed_entrar', '');
  const emojiSair = await obterEmoji('filamed_sair', '');
  const emojiRank = await obterEmoji('filamed_rank', '');
  const emojiConfig = await obterEmoji('filamed_config', '⚙️');

  const btnEntrar = new ButtonBuilder().setCustomId('filamed_entrar').setLabel('Entrar').setStyle(ButtonStyle.Success);
  if (emojiEntrar) btnEntrar.setEmoji(emojiEntrar);
  const btnSair = new ButtonBuilder().setCustomId('filamed_sair').setLabel('Sair').setStyle(ButtonStyle.Danger);
  if (emojiSair) btnSair.setEmoji(emojiSair);
  const btnRank = new ButtonBuilder().setCustomId('filamed_rank').setLabel('Rank').setStyle(ButtonStyle.Secondary);
  if (emojiRank) btnRank.setEmoji(emojiRank);
  const btnConfig = new ButtonBuilder().setCustomId('filamed_config').setStyle(ButtonStyle.Secondary).setEmoji(emojiConfig || '⚙️');

  const row = new ActionRowBuilder().addComponents(btnEntrar, btnSair, btnRank, btnConfig);

  return { embeds: [embed], components: [row] };
}

// Atualiza todos os painéis /filamed já postados (menos o que já foi atualizado pela interação)
async function atualizarPaineisFilaMed(ignorarMessageId = null) {
  const paineis = (await db.get('paineis_filamed')) || [];
  if (paineis.length === 0) return;

  const restantes = [];

  for (const p of paineis) {
    if (p.messageId === ignorarMessageId) {
      restantes.push(p);
      continue;
    }
    try {
      const canal = await client.channels.fetch(p.channelId);
      const msg = await canal.messages.fetch(p.messageId);
      await msg.edit(await montarPainelFilaMed(canal.guild));
      restantes.push(p);
    } catch (e) {
      // 10003 = canal apagado, 10008 = mensagem apagada -> descarta o painel
      if (e && (e.code === 10003 || e.code === 10008)) continue;
      restantes.push(p);
    }
  }

  if (restantes.length !== paineis.length) await db.set('paineis_filamed', restantes);
}

async function montarPainelCadastroMed() {
  const texto = await obterTextoEmbed('cadastromed_painel');
  const embed = new EmbedBuilder()
    .setTitle(texto.titulo)
    .setDescription(texto.descricao)
    .setColor(await corPadrao());

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('cadastromed_cadastrar').setLabel('Cadastrar Chave').setStyle(ButtonStyle.Primary).setEmoji(await obterEmoji('cadastromed_cadastrar', '⚙️')),
    new ButtonBuilder().setCustomId('cadastromed_verificar').setLabel('Verificar Chave').setStyle(ButtonStyle.Primary).setEmoji(await obterEmoji('cadastromed_verificar', '🔍')),
    new ButtonBuilder().setCustomId('cadastromed_verificar_adm').setLabel('Verificar ADM').setStyle(ButtonStyle.Primary).setEmoji(await obterEmoji('cadastromed_verificar_adm', '✅'))
  );

  return { embeds: [embed], components: [row] };
}

// ==========================================
// RANKING DE JOGADORES (/ranking)
// ==========================================

const RANKING_CATEGORIAS = ['vitorias', 'derrotas', 'coins'];
const RANKING_NOMES = { vitorias: 'Vitórias', derrotas: 'Derrotas', coins: 'Coins' };

// Recebe a guild para sempre exibir a foto do servidor na thumbnail do painel.
async function montarPainelRanking(guild) {
  const texto = await obterTextoEmbed('ranking_painel');
  const embed = new EmbedBuilder()
    .setTitle(texto.titulo)
    .setDescription(texto.descricao)
    .setColor(await corPadrao());

  const icone = guild ? guild.iconURL({ size: 512 }) : null;
  if (icone) embed.setThumbnail(icone);

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('ranking_perfil').setLabel('Ver perfil').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('ranking_ranking_vitorias').setLabel('Ver ranking').setStyle(ButtonStyle.Secondary)
  );

  return { embeds: [embed], components: [row] };
}

async function obterTop10Ranking(categoria) {
  const perfis = (await db.get('perfis_jogadores')) || {};
  const lista = Object.entries(perfis)
    .map(([id, p]) => ({ id, valor: (p && p[categoria]) || 0 }))
    .filter(item => item.valor > 0)
    .sort((a, b) => b.valor - a.valor)
    .slice(0, 10);
  return lista;
}

function montarLinhaNavegacaoRanking(categoria) {
  const idx = RANKING_CATEGORIAS.indexOf(categoria);
  const anterior = RANKING_CATEGORIAS[(idx - 1 + RANKING_CATEGORIAS.length) % RANKING_CATEGORIAS.length];
  const proxima = RANKING_CATEGORIAS[(idx + 1) % RANKING_CATEGORIAS.length];

  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`ranking_ranking_${anterior}`).setEmoji('⬅️').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`ranking_ranking_${categoria}`).setLabel(RANKING_NOMES[categoria]).setStyle(ButtonStyle.Primary).setDisabled(true),
    new ButtonBuilder().setCustomId(`ranking_ranking_${proxima}`).setEmoji('➡️').setStyle(ButtonStyle.Secondary)
  );
}

// Recebe a guild para sempre exibir a foto do servidor na thumbnail do ranking.
async function montarEmbedRanking(categoria, guild) {
  const top10 = await obterTop10Ranking(categoria);
  const nomeCategoria = RANKING_NOMES[categoria] || categoria;

  let descricao = 'Nenhum dado encontrado.';
  if (top10.length > 0) {
    descricao = top10
      .map((item, i) => `${i + 1}º - <@${item.id}> — ${item.valor} ${nomeCategoria.toLowerCase()}`)
      .join('\n');
  }
  descricao += '\n\nPágina 1 de 1';

  const embed = new EmbedBuilder()
    .setTitle(`🏆 Ranking de ${nomeCategoria}`)
    .setDescription(descricao)
    .setColor('#0044FF');

  const icone = guild ? guild.iconURL({ size: 512 }) : null;
  if (icone) embed.setThumbnail(icone);

  return { embeds: [embed], components: [montarLinhaNavegacaoRanking(categoria)] };
}

// ==========================================
// RANKING DIÁRIO AUTOMÁTICO (todo dia às 00:00, horário de Brasília)
// Pega o Top 10 de vitórias das últimas 24h e posta no canal configurado em
// /configbot > Ranking Diário, sempre com a foto do servidor na thumbnail.
// ==========================================

function horaAgoraBrasilia() {
  const agora = new Date();
  const partes = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Sao_Paulo',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(agora);
  const obter = (tipo) => partes.find(p => p.type === tipo).value;
  return {
    data: `${obter('year')}-${obter('month')}-${obter('day')}`,
    hora: parseInt(obter('hour'), 10),
    minuto: parseInt(obter('minute'), 10)
  };
}

async function postarRankingDiario() {
  const canalId = await db.get('config_canal_ranking_diario');
  if (!canalId) return;

  const canal = await client.channels.fetch(canalId).catch(() => null);
  if (!canal) return;

  const perfis = (await db.get('perfis_jogadores')) || {};
  const top10 = Object.entries(perfis)
    .map(([id, p]) => ({ id, valor: (p && p.vitoriasDiarias) || 0 }))
    .filter(item => item.valor > 0)
    .sort((a, b) => b.valor - a.valor)
    .slice(0, 10);

  const descricao = top10.length > 0
    ? top10.map((item, i) => `${i + 1}º - <@${item.id}> | **${item.valor}** vitória${item.valor === 1 ? '' : 's'}`).join('\n')
    : 'Nenhuma vitória registrada nas últimas 24h.';

  // Esta função sempre envia a mensagem, mesmo quando ninguém venceu no dia (fica só com o
  // texto de fallback acima), pois o ranking diário deve ser postado incondicionalmente.
  const embed = new EmbedBuilder()
    .setTitle('🏆 Destaque Diário')
    .setDescription(`Jogadores com mais vitórias nas últimas 24h:\n\n${descricao}`)
    .setColor(await corPadrao());

  const icone = canal.guild ? canal.guild.iconURL({ size: 512 }) : null;
  if (icone) embed.setThumbnail(icone);

  await canal.send({ embeds: [embed] }).catch((e) => console.error('Erro ao enviar ranking diário:', e));

  // Zera as vitórias diárias para a contagem das próximas 24h começar do zero
  for (const id of Object.keys(perfis)) {
    if (perfis[id]) perfis[id].vitoriasDiarias = 0;
  }
  await db.set('perfis_jogadores', perfis);
}

async function verificarRankingDiario() {
  try {
    const { data, hora, minuto } = horaAgoraBrasilia();
    if (hora !== 0 || minuto !== 0) return;

    const ultimoEnvio = await db.get('ultimo_ranking_diario');
    if (ultimoEnvio === data) return;

    await comTrava('ranking_diario', async () => {
      const ultimo = await db.get('ultimo_ranking_diario');
      if (ultimo === data) return;
      await postarRankingDiario();
      await db.set('ultimo_ranking_diario', data);
    });
  } catch (e) {
    console.error('Erro ao verificar ranking diário:', e);
  }
}

// ==========================================
// PARTIDA: BOTÕES, PIX, PERFIL, RESULTADOS E PAINEL DO MEDIADOR
// ==========================================

async function montarBotoesPartida(threadId, desabilitado = false) {
  const btnConfirmar = new ButtonBuilder()
    .setCustomId(`partida_confirmar_${threadId}`)
    .setLabel('Confirmar')
    .setStyle(ButtonStyle.Success)
    .setEmoji(await obterEmoji('partida_confirmar', '✅'))
    .setDisabled(desabilitado);
  const btnCancelar = new ButtonBuilder()
    .setCustomId(`partida_cancelar_${threadId}`)
    .setLabel('Cancelar')
    .setStyle(ButtonStyle.Danger)
    .setEmoji(await obterEmoji('partida_cancelar', '❌'))
    .setDisabled(desabilitado);

  return new ActionRowBuilder().addComponents(btnConfirmar, btnCancelar);
}

function montarEmbedPix(pix, mediadorId) {
  return new EmbedBuilder()
    .setTitle('💠 Chave PIX do Mediador')
    .setDescription(`**Banco:** ${pix.banco || 'não informado'}\n**Titular:** ${pix.titular}\n**Chave:** \`${pix.chave}\`\n\n**Mediador:** <@${mediadorId}>`)
    .setColor('#0044FF');
}

// Perfil do jogador (comando .p)
function montarEmbedPerfil(user, perfil) {
  const p = perfil || { vitorias: 0, derrotas: 0, consecutivas: 0, coins: 0 };
  const total = p.vitorias + p.derrotas;
  const sep = '\u3164\u3164';

  const descricao =
    `**Vitórias:** ${p.vitorias}${sep}**Derrotas:** ${p.derrotas}\n\n` +
    `**Consecutivas:** ${p.consecutivas}${sep}**Total:** ${total}\n\n` +
    `**Coins:** ${p.coins}`;

  return new EmbedBuilder()
    .setTitle(`📊 Perfil de ${user.username}`)
    .setDescription(descricao)
    .setColor('#E67300')
    .setThumbnail(user.displayAvatarURL({ size: 256 }));
}

// tipo: 'vit' = vitória (+1 vitória, +1 coin) | 'wo' = vitória por W.O. (+1 vitória, sem coin)
// O perdedor sempre recebe +1 derrota e zera as consecutivas.
// vitoriasDiarias alimenta o /ranking diário automático (reseta a cada 24h, à 00:00 de Brasília).
async function registrarResultado(vencedorId, perdedorId, tipo) {
  return comTrava('perfis_jogadores', async () => {
    const perfis = (await db.get('perfis_jogadores')) || {};
    const obter = (id) => {
      if (!perfis[id]) perfis[id] = { vitorias: 0, derrotas: 0, consecutivas: 0, coins: 0, vitoriasDiarias: 0 };
      if (perfis[id].vitoriasDiarias === undefined) perfis[id].vitoriasDiarias = 0;
      return perfis[id];
    };

    const vencedor = obter(vencedorId);
    vencedor.vitorias += 1;
    vencedor.vitoriasDiarias += 1;
    vencedor.consecutivas += 1;
    if (tipo === 'vit') vencedor.coins += 1;

    const perdedor = obter(perdedorId);
    perdedor.derrotas += 1;
    perdedor.consecutivas = 0;

    await db.set('perfis_jogadores', perfis);
  });
}

function interpretarSimNao(texto) {
  const t = String(texto || '').trim().toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  if (['sim', 's', 'yes', 'y'].includes(t)) return true;
  if (['nao', 'n', 'no'].includes(t)) return false;
  return null;
}

// Carrega a aposta e confere se quem clicou é o mediador dela
async function carregarApostaDoMediador(interaction, threadId) {
  const matchData = await db.get(`match_${threadId}`);
  if (!matchData) {
    await interaction.reply({ content: 'Partida não encontrada.', ephemeral: true });
    return null;
  }
  if (interaction.user.id !== matchData.mediadorId) {
    await interaction.reply({ content: '❌ Você não tem permissão para isso.', ephemeral: true });
    return null;
  }
  return matchData;
}

// Painel aberto pelo comando .med dentro do tópico da aposta — visual "Menu ADM" (cartão com
// borda colorida) + uma barra de seleção (StringSelectMenu) com as ações do mediador.
async function montarPainelMediador(matchData, threadId) {
  const embed = new EmbedBuilder()
    .setDescription(
      `## Menu ADM\n\n` +
      `**Partida:**\n${matchData.numero || '—'}\n\n` +
      `**Modo:**\n${matchData.modalidade}${matchData.regra ? ' ' + matchData.regra : ''}\n\n` +
      `**Valor:**\nR$ ${formatarValorVisual(matchData.valor)}\n\n` +
      `**Jogadores:**\n<@${matchData.p1}> <@${matchData.p2}>\n\n` +
      `**Mediador:**\n<@${matchData.mediadorId}>`
    )
    .setColor('#FF0000');

  const select = new StringSelectMenuBuilder()
    .setCustomId(`med_menu_${threadId}`)
    .setPlaceholder('Use .med para trazer esse menu')
    .addOptions([
      { label: 'Escolha o vencedor', description: 'Escolha o vencedor da aposta.', value: 'vencedor', emoji: '🏅' },
      { label: 'Finalizar aposta', description: 'Clique nessa opção para finalizar a aposta.', value: 'finalizar', emoji: '🏁' },
      { label: 'Vitória por W.O', description: 'Clique nessa opção para dar vitória por W.O.', value: 'wo', emoji: '🚩' },
      { label: 'Revanche', description: 'Clique nessa opção para criar uma revanche desta aposta.', value: 'revanche', emoji: '🔁' },
      { label: 'Alterar Valor', description: 'Clique nessa opção para alterar o valor.', value: 'alterar_valor', emoji: '✏️' },
      { label: 'Libera Chaves', description: 'Clique nessa opção para liberar o envio de chave PIX.', value: 'liberar_chave', emoji: '💠' }
    ]);

  return { embeds: [embed], components: [new ActionRowBuilder().addComponents(select)] };
}

function montarModalAlterarValor(threadId, valorAtual) {
  const modal = new ModalBuilder().setCustomId(`modal_alterar_valor_${threadId}`).setTitle('Alterar Valor');
  const input = new TextInputBuilder()
    .setCustomId('novo_valor_input')
    .setLabel('Novo valor (Ex: 0,50)')
    .setStyle(TextInputStyle.Short)
    .setPlaceholder('0,50')
    .setValue(formatarValorVisual(valorAtual))
    .setRequired(true);
  modal.addComponents(new ActionRowBuilder().addComponents(input));
  return modal;
}

// ==========================================
// FILA CONTRA STREAMER (/contra-streamer)
// Painel do streamer redesenhado: Puxar Jogador, Definir Regras, Definir Modo, Remover
// Jogadores e o botão de Ativar/Desativar a fila. O mediador da partida é sorteado
// automaticamente (mesma fila FIFO de /filamed) no momento em que o streamer "puxa" o(s)
// jogador(es), e o tópico da partida já nasce criado com todos os envolvidos.
// ==========================================

let donoDoBotIdCache = null;

// Dono do bot = dono do app no Discord Developer Portal (ou o ID da variável BOT_OWNER_ID)
async function obterDonoDoBotId() {
  if (process.env.BOT_OWNER_ID) return process.env.BOT_OWNER_ID;
  if (donoDoBotIdCache) return donoDoBotIdCache;
  try {
    const aplicacao = await client.application.fetch();
    const dono = aplicacao.owner;
    if (dono) donoDoBotIdCache = dono.ownerId || dono.id;
  } catch (e) {
    console.error('Não consegui descobrir o dono do bot:', e.message);
  }
  return donoDoBotIdCache;
}

// Extrai o tamanho do time a partir do texto do modo (Ex: "2x2 MOB" -> 2, "1x1 EMU" -> 1)
function obterTamanhoTimeModo(modo) {
  const match = String(modo || '').match(/^(\d+)/);
  return match ? parseInt(match[1], 10) : 1;
}

// Mensagem pública da fila: 2 embeds + botões Jogar/Sair
async function montarFilaStreamer(data) {
  const regras = data.regras && data.regras.trim() ? data.regras.trim() : 'Regras ainda não definidas.';
  const status = data.aberta ? '' : '\n\n🔒 **Fila fechada**';
  const cor = await corPadrao();

  const embedInfo = new EmbedBuilder()
    .setDescription(`## 👑 FILA CONTRA <@${data.streamerId}>\n${regras}${status}`)
    .setColor(cor);

  const lista = data.jogadores.length > 0
    ? data.jogadores.map((uid, i) => `${i + 1}º - <@${uid}>`).join('\n')
    : 'Nenhum jogador na fila.';

  const embedJogadores = new EmbedBuilder()
    .setDescription(`## 👥 Jogadores na fila\n${lista}`)
    .setColor(cor);

  const btnJogar = new ButtonBuilder().setCustomId(`streamer_jogar_${data.id}`).setLabel('Jogar').setStyle(ButtonStyle.Success).setDisabled(!data.aberta);
  const emojiJogar = await obterEmoji('streamer_jogar', '');
  if (emojiJogar) btnJogar.setEmoji(emojiJogar);

  const btnSair = new ButtonBuilder().setCustomId(`streamer_sair_${data.id}`).setLabel('Sair').setStyle(ButtonStyle.Danger);
  const emojiSair = await obterEmoji('streamer_sair', '');
  if (emojiSair) btnSair.setEmoji(emojiSair);

  const row = new ActionRowBuilder().addComponents(btnJogar, btnSair);

  return { embeds: [embedInfo, embedJogadores], components: [row] };
}

// Painel do canal privado do streamer: regras, modo, puxar jogador, remover jogadores e
// abrir/fechar a fila. Layout segue o modelo de referência do painel de streamer.
async function montarPainelStreamer(data) {
  const regras = data.regras && data.regras.trim() ? data.regras.trim() : 'Ainda não definidas.';
  const modoAtual = data.modo || '1x1 MOB';

  const embed = new EmbedBuilder()
    .setDescription(
      `## 🎙️ Painel do Streamer • <@${data.streamerId}>\n\n` +
      `Defina suas Regras\n` +
      `Puxe um Jogador para sua fila\n` +
      `Defina Modo: 1V1, 2V2, 3V3, 4V4/MOB, EMU, MISTO\n` +
      `Remover todos os Jogadores da Fila\n\n` +
      `**Modo Atual**\n${modoAtual}\n\n` +
      `**Status:** ${data.aberta ? 'Ativada' : 'Desativada'}` +
      (regras !== 'Ainda não definidas.' ? `\n\n**Regras:**\n${regras}` : '')
    )
    .setColor(await corPadrao());

  const botaoToggle = new ButtonBuilder()
    .setCustomId(`streamerpainel_toggle_${data.id}`)
    .setLabel(data.aberta ? 'Desativar' : 'Ativar')
    .setStyle(data.aberta ? ButtonStyle.Danger : ButtonStyle.Success)
    .setEmoji('⚡');

  const rowToggle = new ActionRowBuilder().addComponents(botaoToggle);

  const rowAcoes1 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`streamerpainel_puxar_${data.id}`).setLabel('Puxar Jogador').setStyle(ButtonStyle.Primary).setEmoji(await obterEmoji('streamerpainel_puxar', '🎯')),
    new ButtonBuilder().setCustomId(`streamerpainel_regras_${data.id}`).setLabel('Definir Regras').setStyle(ButtonStyle.Primary).setEmoji(await obterEmoji('streamerpainel_regras', '⚙️'))
  );

  const rowAcoes2 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`streamerpainel_modo_${data.id}`).setLabel('Definir Modo').setStyle(ButtonStyle.Secondary).setEmoji(await obterEmoji('streamerpainel_modo', '🎮')),
    new ButtonBuilder().setCustomId(`streamerpainel_remover_${data.id}`).setLabel('Remover Jogadores').setStyle(ButtonStyle.Secondary).setEmoji(await obterEmoji('streamerpainel_remover', '👥'))
  );

  return { embeds: [embed], components: [rowToggle, rowAcoes1, rowAcoes2] };
}

// Atualiza a fila pública e o painel privado com o estado atual
async function atualizarFilaStreamer(data) {
  try {
    const canal = await client.channels.fetch(data.canalId);
    const msg = await canal.messages.fetch(data.mensagemId);
    await msg.edit(await montarFilaStreamer(data));
  } catch (e) {
    console.error('Erro ao atualizar a fila pública do streamer:', e.message);
  }

  try {
    const canalPrivado = await client.channels.fetch(data.id);
    const msgPainel = await canalPrivado.messages.fetch(data.painelMensagemId);
    await msgPainel.edit(await montarPainelStreamer(data));
  } catch (e) {
    console.error('Erro ao atualizar o painel do streamer:', e.message);
  }
}

// Quem pode mexer no painel: o streamer, o dono do servidor, o dono do bot e administradores
async function podeGerenciarStreamer(interaction, data) {
  if (interaction.user.id === data.streamerId) return true;
  if (interaction.guild && interaction.user.id === interaction.guild.ownerId) return true;
  if (interaction.user.id === (await obterDonoDoBotId())) return true;
  return ehAdmin(interaction);
}

// Se a criação do tópico da partida contra o streamer falhar, devolve os jogadores puxados
// para o início da fila e o mediador sorteado de volta para o topo da fila de mediadores.
async function devolverJogadoresStreamer(chave, jogadoresPuxados, mediadorId) {
  await comTrava(`streamer_${chave}`, async () => {
    const atual = await db.get(`streamer_${chave}`);
    if (!atual) return;
    const jaTem = new Set(atual.jogadores);
    atual.jogadores = [...jogadoresPuxados.filter(j => !jaTem.has(j)), ...atual.jogadores];
    await db.set(`streamer_${chave}`, atual);
  });

  if (mediadorId) {
    await comTrava('mediadores', async () => {
      const filaMed = (await db.get('fila_mediadores_fifo')) || [];
      if (!filaMed.includes(mediadorId)) return;
      await db.set('fila_mediadores_fifo', [mediadorId, ...filaMed.filter(id => id !== mediadorId)]);
    });
  }
}

// Canal privado: só o bot, o streamer, o dono do servidor e o dono do bot enxergam
async function criarCanalPrivadoStreamer(guild, streamerUser, categoriaId) {
  const donoDoBotId = await obterDonoDoBotId();
  const permitidos = [...new Set([streamerUser.id, guild.ownerId, donoDoBotId].filter(Boolean))];

  const permissoes = [
    { id: guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
    {
      id: client.user.id,
      allow: [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.ReadMessageHistory,
        PermissionFlagsBits.EmbedLinks
      ]
    }
  ];

  for (const uid of permitidos) {
    if (uid === client.user.id) continue;
    const membro = await guild.members.fetch(uid).catch(() => null);
    if (!membro) continue; // o dono do bot pode não estar neste servidor
    permissoes.push({
      id: uid,
      allow: [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.ReadMessageHistory
      ]
    });
  }

  const nomeLimpo = String(streamerUser.username || '').toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 80);

  return guild.channels.create({
    name: `streamer-${nomeLimpo || 'painel'}`,
    type: ChannelType.GuildText,
    parent: categoriaId || undefined,
    permissionOverwrites: permissoes,
    reason: `Painel da fila contra streamer (${streamerUser.username})`
  });
}

// ==========================================
// SISTEMA DE TICKETS (/configticket)
// Cada ticket vira um TÓPICO PRIVADO (não canal) dentro do canal configurado na opção, nomeado
// "<opção>-<usuário>". O painel principal já mostra a barra de seleção com as opções (sem botão).
// Dados: "ticket_<threadId>" guarda { threadId, userId, opcaoNome, assumidoPor }.
// "ticket_aberto_<userId>" guarda o threadId do ticket em aberto daquele usuário, para que,
// se ele tentar abrir outro ticket, o bot devolva o acesso ao mesmo tópico em vez de criar um novo.
// ==========================================

function montarPainelConfigTicket() {
  const embed = new EmbedBuilder()
    .setTitle('🎫 Configuração do Sistema de Tickets')
    .setDescription(
      '**Nome** — título usado na embed do painel de tickets.\n' +
      '**Descrição** — texto usado na embed do painel de tickets.\n' +
      '**Setores** — canais que podem ser usados como destino dos tickets (os tópicos nascem dentro deles).\n' +
      '**Opção** — cria uma nova opção no menu do ticket (nome, emoji e ID do canal onde ela vai criar o tópico).\n' +
      '**Remover Opção** — apaga uma opção já criada.\n' +
      '**Cargo Staff** — quem pode Finalizar, Assumir e usar o Painel Staff dentro dos tickets.\n\n' +
      'Depois de configurar, use **Publicar Painel Aqui** para postar o painel de tickets neste canal.'
    )
    .setColor('#0044FF');

  const row1 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('ticket_config_nome').setLabel('Nome').setStyle(ButtonStyle.Primary).setEmoji('📝'),
    new ButtonBuilder().setCustomId('ticket_config_descricao').setLabel('Descrição').setStyle(ButtonStyle.Primary).setEmoji('📄'),
    new ButtonBuilder().setCustomId('ticket_config_setores').setLabel('Setores').setStyle(ButtonStyle.Primary).setEmoji('🗂️'),
    new ButtonBuilder().setCustomId('ticket_config_opcao').setLabel('Opção').setStyle(ButtonStyle.Success).setEmoji('➕'),
    new ButtonBuilder().setCustomId('ticket_config_remover_opcao').setLabel('Remover Opção').setStyle(ButtonStyle.Danger).setEmoji('🗑️')
  );
  const row2 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('ticket_config_staff').setLabel('Cargo Staff').setStyle(ButtonStyle.Primary).setEmoji('🛡️'),
    new ButtonBuilder().setCustomId('ticket_config_publicar').setLabel('Publicar Painel Aqui').setStyle(ButtonStyle.Secondary).setEmoji('📌')
  );

  return { embeds: [embed], components: [row1, row2] };
}

// Embed + barra de seleção (StringSelectMenu direto, sem botão intermediário). A foto do
// servidor aparece como thumbnail (à direita).
async function montarEmbedTicketPrincipal(guild) {
  const nome = (await db.get('config_ticket_nome')) || '🎫 Central de Tickets';
  const descricao = (await db.get('config_ticket_descricao')) || 'Para obter atendimento, selecione uma opção abaixo.';
  const opcoes = (await db.get('config_ticket_opcoes')) || [];

  const embed = new EmbedBuilder()
    .setDescription(`## ${nome}\n${descricao}`)
    .setColor(await corPadrao());

  const icone = guild ? guild.iconURL({ size: 512 }) : null;
  if (icone) embed.setThumbnail(icone);

  if (opcoes.length === 0) {
    return { embeds: [embed], components: [] };
  }

  const select = new StringSelectMenuBuilder()
    .setCustomId('ticket_selecionar_opcao')
    .setPlaceholder('Selecione uma Opção abaixo.')
    .addOptions(opcoes.slice(0, 25).map((op, i) => {
      const opt = {
        label: op.nome.slice(0, 100),
        description: `Clique aqui caso precise de ${op.nome}.`.slice(0, 100),
        value: String(i)
      };
      if (op.emoji) opt.emoji = op.emoji;
      return opt;
    }));

  return { embeds: [embed], components: [new ActionRowBuilder().addComponents(select)] };
}

// Embed em formato "barra" mostrada dentro do próprio tópico do ticket
function montarEmbedTicketCanal(guild, usuario, opcaoNome, corHex) {
  const embed = new EmbedBuilder()
    .setDescription(
      `## 🎫 ${opcaoNome}\n` +
      `Ticket aberto por <@${usuario.id}>.\n\n` +
      `Aguarde, em breve a equipe irá te atender.`
    )
    .setColor(corHex);

  const icone = guild ? guild.iconURL({ size: 512 }) : null;
  if (icone) embed.setThumbnail(icone);

  return embed;
}

async function montarBotoesTicket(threadId) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`ticket_finalizar_${threadId}`).setLabel('Finalizar Ticket').setStyle(ButtonStyle.Success).setEmoji(await obterEmoji('ticket_finalizar', '✅')),
    new ButtonBuilder().setCustomId(`ticket_assumir_${threadId}`).setLabel('Assumir Ticket').setStyle(ButtonStyle.Secondary).setEmoji(await obterEmoji('ticket_assumir', '🛠️')),
    new ButtonBuilder().setCustomId(`ticket_painel_staff_${threadId}`).setLabel('Painel Staff').setStyle(ButtonStyle.Secondary).setEmoji(await obterEmoji('ticket_painel_staff', '🛡️')),
    new ButtonBuilder().setCustomId(`ticket_sair_${threadId}`).setLabel('Sair Ticket').setStyle(ButtonStyle.Danger).setEmoji(await obterEmoji('ticket_sair', '✏️'))
  );
}

// Busca todos os membros que têm algum dos cargos de staff configurados (para adicioná-los ao
// tópico privado do ticket assim que ele é criado). Precisa do intent privilegiado GuildMembers
// (ative "Server Members Intent" no Developer Portal), senão guild.members.fetch() falha.
async function membrosComCargoStaff(guild) {
  const cargosStaff = (await db.get('config_ticket_staff_cargos')) || [];
  if (cargosStaff.length === 0) return [];
  try {
    const membros = await guild.members.fetch();
    return membros.filter(m => membroTemAlgumCargo(m, cargosStaff)).map(m => m.id);
  } catch (e) {
    console.error('Erro ao buscar membros da staff:', e);
    return [];
  }
}

// Cria o tópico privado do ticket dentro do canal configurado na opção, nomeado "<opção>-<usuário>"
async function criarCanalDeTicket(guild, usuario, opcao) {
  const destino = await client.channels.fetch(opcao.canalId).catch(() => null);
  if (!destino) return { erro: '❌ O canal configurado para esta opção não foi encontrado. Avise um administrador.' };
  if (destino.type === ChannelType.GuildCategory || !destino.threads) {
    return { erro: '❌ Essa opção está configurada com uma categoria. Configure com o ID de um canal de texto (os tickets nascem como tópico dentro dele).' };
  }

  const slugOpcao = String(opcao.nome || 'ticket').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  const slugUsuario = String(usuario.username || usuario.id).toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');
  const nomeTopico = `${slugOpcao || 'ticket'}-${slugUsuario || usuario.id}`.slice(0, 90);

  try {
    const topico = await destino.threads.create({
      name: nomeTopico,
      type: ChannelType.PrivateThread,
      reason: `Ticket de ${opcao.nome} aberto por ${usuario.tag}`
    });

    await topico.members.add(usuario.id).catch(() => {});
    const staffIds = await membrosComCargoStaff(guild);
    for (const uid of staffIds) {
      await topico.members.add(uid).catch(() => {});
    }

    return { canal: topico };
  } catch (err) {
    console.error('Erro ao criar o tópico do ticket:', err);
    return { erro: '❌ Não consegui criar o ticket. Confira se o bot tem permissão "Criar Tópicos Privados" nesse canal e se o intent "Server Members Intent" está ativado no Developer Portal.' };
  }
}

// Restaura o acesso do dono ao ticket já existente (usado quando ele tenta abrir outro ticket)
async function reabrirTicketExistente(topico, usuario) {
  if (topico.archived) await topico.setArchived(false).catch(() => {});
  await topico.members.add(usuario.id).catch(() => {});
}

// ==========================================
// MATCHMAKING E CRIAÇÃO DE PARTIDA
// ==========================================

// Envia uma mensagem no canal e apaga depois de um tempo
async function enviarAvisoTemporario(canal, conteudo, ms = 60000) {
  try {
    const msg = await canal.send({ content: conteudo });
    setTimeout(() => msg.delete().catch(() => {}), ms);
  } catch (e) {}
}

// Se a criação da sala falhar, devolve os jogadores e o mediador para o lugar deles
async function devolverReserva(filaMessageId, jogadoresReservados, mediadorId) {
  await comTrava(`fila_${filaMessageId}`, async () => {
    const atual = await db.get(`fila_${filaMessageId}`);
    if (!atual) return;
    const jaTem = new Set(atual.jogadores.map(j => j.id));
    atual.jogadores = [...jogadoresReservados.filter(j => !jaTem.has(j.id)), ...atual.jogadores];
    await db.set(`fila_${filaMessageId}`, atual);
  });

  await comTrava('mediadores', async () => {
    const filaMed = (await db.get('fila_mediadores_fifo')) || [];
    if (!filaMed.includes(mediadorId)) return;
    await db.set('fila_mediadores_fifo', [mediadorId, ...filaMed.filter(id => id !== mediadorId)]);
  });

  atualizarPaineisFilaMed().catch(() => {});
}

async function verificarEMatchmaking(filaMessageId) {
  const filaData = await db.get(`fila_${filaMessageId}`);
  if (!filaData || !filaData.jogadores) return;

  const gruposPorRegra = {};
  for (const jogador of filaData.jogadores) {
    if (!gruposPorRegra[jogador.regra]) gruposPorRegra[jogador.regra] = [];
    gruposPorRegra[jogador.regra].push(jogador.id);
  }

  for (const [regra, ids] of Object.entries(gruposPorRegra)) {
    if (ids.length < 2) continue;

    const p1 = ids[0];
    const p2 = ids[1];

    const canal = await client.channels.fetch(filaData.channelId).catch(() => null);
    if (!canal) return;

    // Reserva (com trava) os 2 jogadores e o mediador ANTES de esperar a rede. Assim, se alguém
    // entrar na fila enquanto a sala é criada, não nasce uma segunda sala com os mesmos jogadores.
    // Sem mediador online a sala não é criada: os jogadores continuam na fila e ela sai quando
    // um mediador entrar (o aviso privado é dado na hora de clicar para entrar na fila).
    const reserva = await comTrava(`fila_${filaMessageId}`, async () => {
      const fresco = await db.get(`fila_${filaMessageId}`);
      if (!fresco) return null;

      const reservados = fresco.jogadores.filter(j => (j.id === p1 || j.id === p2) && j.regra === regra);
      if (reservados.length < 2) return null; // alguém saiu ou outra checagem já pegou

      const mediadorEscolhido = await pegarMediadorEGirar();
      if (!mediadorEscolhido) return null;

      fresco.jogadores = fresco.jogadores.filter(j => j.id !== p1 && j.id !== p2);
      await db.set(`fila_${filaMessageId}`, fresco);
      return { reservados, mediadorId: mediadorEscolhido };
    });

    if (!reserva) return;
    const { reservados, mediadorId } = reserva;
    atualizarPaineisFilaMed().catch(() => {});

    // Canal onde os tópicos são criados (configurado em /configfilas > Filas)
    const canalTopicosId = await db.get('config_canal_topicos');
    let canalTopicos = canal;
    if (canalTopicosId) {
      const configurado = await client.channels.fetch(canalTopicosId).catch(() => null);
      if (configurado) canalTopicos = configurado;
    }

    let thread;
    try {
      thread = await canalTopicos.threads.create({
        name: `partida-${p1.slice(-4)}-vs-${p2.slice(-4)}`,
        autoArchiveDuration: 60,
        type: ChannelType.PrivateThread,
        reason: 'Partida Criada'
      });
    } catch (e) {
      console.error('Erro ao criar o tópico da partida:', e);
      await devolverReserva(filaMessageId, reservados, mediadorId);
      await enviarAvisoTemporario(canal, `❌ Não consegui criar o tópico da partida em <#${canalTopicos.id}>. Verifique se o bot pode criar tópicos privados nesse canal.`);
      return;
    }

    const foto = await resolverFoto(canal.guild);

    // Atualiza a embed da fila com quem está nela agora
    try {
      const estadoAtual = (await db.get(`fila_${filaMessageId}`)) || filaData;
      const msgFila = await canal.messages.fetch(filaMessageId);
      const imagem = await db.get('config_imagem');
      const novaEmbed = criarEmbedFila(estadoAtual.modalidade, estadoAtual.valor, estadoAtual.jogadores, foto, imagem);
      await msgFila.edit({ embeds: [novaEmbed] });
    } catch (e) {}

    const ownerId = await db.get('config_owner_id');

    await thread.members.add(p1).catch(() => {});
    await thread.members.add(p2).catch(() => {});
    await thread.members.add(mediadorId).catch(() => {});
    if (ownerId) await thread.members.add(ownerId).catch(() => {});

    // Valor que cada jogador paga = valor da fila + taxa da org (sem taxa, só o valor da fila)
    const valorExibicao = await calcularValorComTaxaVirtual(filaData.valor);
    const numeroPartida = await proximoNumeroPartida();

    await db.set(`match_${thread.id}`, {
      numero: numeroPartida,
      p1,
      p2,
      mediadorId,
      regra,
      modalidade: filaData.modalidade,
      valor: filaData.valor,
      valorPagar: valorExibicao,
      confirmations: []
    });

    // Embed em formato "barra" (a cor lateral já é a própria borda da embed) igual ao restante do
    // fluxo de confirmação: título + campos com ícones (Modo, Valor, Jogadores, Mediador).
    const matchEmbed = new EmbedBuilder()
      .setDescription(
        `## Aguardando Confirmações\n\n` +
        `🎮 **Modo**\n${filaData.modalidade} | ${regra}\n\n` +
        `💰 **Valor**\nR$ ${valorExibicao}\n\n` +
        `👤 **Jogadores**\n<@${p1}>\n<@${p2}>\n\n` +
        `🛡️ **Mediador**\n<@${mediadorId}>`
      )
      .setColor('#FF0000');

    if (foto) matchEmbed.setThumbnail(foto);

    const rowButtons = await montarBotoesPartida(thread.id);

    await thread.send({
      content: `<@${p1}> <@${p2}> <@${mediadorId}>`,
      embeds: [matchEmbed],
      components: [rowButtons]
    });

    // A chave PIX do mediador NÃO é enviada aqui: só depois que os 2 confirmarem (botão "Liberar Chave")
    return;
  }
}

// ==========================================
// INTERAÇÕES E COMANDOS
// ==========================================

client.on(Events.InteractionCreate, async (interaction) => {
  try {
    if (interaction.isChatInputCommand()) {
      const { commandName } = interaction;

      if (commandName === 'configfilas') {
        if (!interaction.deferred && !interaction.replied) await interaction.deferReply({ ephemeral: true });

        const row1 = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId('configfilas_valores').setLabel('💰 Valores').setStyle(ButtonStyle.Primary),
          new ButtonBuilder().setCustomId('configfilas_criar').setLabel('➕ Criar Várias Filas').setStyle(ButtonStyle.Success),
          new ButtonBuilder().setCustomId('configfilas_local').setLabel('📂 Filas').setStyle(ButtonStyle.Secondary)
        );

        const row2 = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId('configfilas_foto').setLabel('🖼️ Foto').setStyle(ButtonStyle.Secondary),
          new ButtonBuilder().setCustomId('configfilas_imagem').setLabel('🌄 Imagem Filas').setStyle(ButtonStyle.Secondary),
          new ButtonBuilder().setCustomId('configfilas_excluir').setLabel('🗑️ Excluir Várias Filas').setStyle(ButtonStyle.Danger)
        );

        return interaction.editReply({
          content: '⚙️ **Painel de Configuração das Filas**',
          components: [row1, row2]
        });
      }

      if (commandName === 'configbot') {
        if (!interaction.deferred && !interaction.replied) await interaction.deferReply({ ephemeral: true });

        const row = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId('configbot_taxa').setLabel('💰 Taxa da Org').setStyle(ButtonStyle.Primary),
          new ButtonBuilder().setCustomId('configbot_analista').setLabel('🛡️ Analista').setStyle(ButtonStyle.Primary),
          new ButtonBuilder().setCustomId('configbot_cargos').setLabel('👥 Cargos').setStyle(ButtonStyle.Primary),
          new ButtonBuilder().setCustomId('configbot_cor').setLabel('🎨 Cor da Org').setStyle(ButtonStyle.Primary),
          new ButtonBuilder().setCustomId('configbot_logs').setLabel('📜 Logs Gerais').setStyle(ButtonStyle.Primary)
        );

        const row2 = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId('configbot_mediador').setLabel('🎖️ Cargo Mediador').setStyle(ButtonStyle.Primary),
          new ButtonBuilder().setCustomId('configbot_canal_p').setLabel('📇 Canal .p').setStyle(ButtonStyle.Primary)
        );

        return interaction.editReply({
          content: '⚙️ **Painel de Configuração do Bot**',
          components: [row, row2]
        });
      }

      if (commandName === 'filamed') {
        if (!interaction.deferred && !interaction.replied) await interaction.deferReply({ ephemeral: true });

        const msg = await interaction.channel.send(await montarPainelFilaMed(interaction.guild));
        const paineis = (await db.get('paineis_filamed')) || [];
        paineis.push({ channelId: interaction.channel.id, messageId: msg.id });
        await db.set('paineis_filamed', paineis);

        return interaction.editReply({ content: '✅ Painel da fila de mediadores criado neste canal.' });
      }

      if (commandName === 'contra-streamer') {
        if (!interaction.deferred && !interaction.replied) await interaction.deferReply({ ephemeral: true });

        const streamerUser = interaction.options.getUser('streamer', true);
        const categoriaId = interaction.channel && interaction.channel.parent && interaction.channel.parent.type === ChannelType.GuildCategory
          ? interaction.channel.parentId
          : null;

        // 1) Canal privado (bot, streamer, dono do servidor e dono do bot)
        let canalPrivado;
        try {
          canalPrivado = await criarCanalPrivadoStreamer(interaction.guild, streamerUser, categoriaId);
        } catch (err) {
          console.error('Erro ao criar o canal privado do streamer:', err);
          return interaction.editReply({ content: '❌ Não consegui criar o canal privado. Dê ao bot as permissões "Gerenciar Canais" e "Gerenciar Cargos" e tente de novo.' });
        }

        const data = {
          id: canalPrivado.id,
          streamerId: streamerUser.id,
          regras: '',
          modo: '1x1 MOB',
          aberta: true,
          jogadores: [],
          canalId: interaction.channel.id,
          mensagemId: null,
          painelMensagemId: null
        };

        // 2) Fila pública no canal atual + 3) painel dentro do canal privado
        let msgFila = null;
        try {
          msgFila = await interaction.channel.send(await montarFilaStreamer(data));
          data.mensagemId = msgFila.id;

          const msgPainel = await canalPrivado.send({
            content: `🎙️ <@${streamerUser.id}>`,
            ...(await montarPainelStreamer(data))
          });
          data.painelMensagemId = msgPainel.id;

          await db.set(`streamer_${data.id}`, data);
        } catch (err) {
          console.error('Erro ao criar a fila contra streamer:', err);
          if (msgFila) await msgFila.delete().catch(() => {});
          await canalPrivado.delete().catch(() => {});
          return interaction.editReply({ content: '❌ Não consegui criar a fila contra streamer. Confira as permissões do bot neste canal e tente de novo.' });
        }

        return interaction.editReply({ content: `✅ Fila contra <@${streamerUser.id}> criada! Painel do streamer: <#${canalPrivado.id}>` });
      }

      if (commandName === 'cadastromed') {
        if (!interaction.deferred && !interaction.replied) await interaction.deferReply({ ephemeral: true });

        await interaction.channel.send(await montarPainelCadastroMed());
        return interaction.editReply({ content: '✅ Painel de cadastro de chave PIX criado neste canal.' });
      }

      if (commandName === 'ranking') {
        if (!interaction.deferred && !interaction.replied) await interaction.deferReply({ ephemeral: true });

        await interaction.channel.send(await montarPainelRanking(interaction.guild));
        return interaction.editReply({ content: '✅ Painel de perfil e ranking criado neste canal.' });
      }

      if (commandName === 'rank') {
        if (!interaction.deferred && !interaction.replied) await interaction.deferReply({ ephemeral: true });

        const canal = interaction.options.getChannel('canal', true);
        await db.set('config_canal_ranking_diario', canal.id);

        return interaction.editReply({
          content: `✅ Ranking diário configurado! Todos os dias às 00:00 (horário de Brasília), os 10 jogadores com mais vitórias do servidor serão enviados em <#${canal.id}>.`
        });
      }

      if (commandName === 'configticket') {
        if (!interaction.deferred && !interaction.replied) await interaction.deferReply({ ephemeral: true });
        return interaction.editReply(montarPainelConfigTicket());
      }

      if (commandName === 'embed') {
        if (!interaction.deferred && !interaction.replied) await interaction.deferReply({ ephemeral: true });
        rascunhosEmbed.delete(interaction.user.id);
        return interaction.editReply(montarPainelEmbedCustom(interaction.user.id));
      }
    }

    if (interaction.isModalSubmit()) {
      if (interaction.customId.startsWith('modal_alterar_valor_')) {
        if (!interaction.deferred && !interaction.replied) await interaction.deferReply({ ephemeral: true });
        const threadId = interaction.customId.replace('modal_alterar_valor_', '');

        const matchData = await db.get(`match_${threadId}`);
        if (!matchData) return interaction.editReply({ content: 'Partida não encontrada.' });
        if (interaction.user.id !== matchData.mediadorId) {
          return interaction.editReply({ content: '❌ Você não tem permissão para isso.' });
        }

        const novoValorCentavos = paraCentavos(interaction.fields.getTextInputValue('novo_valor_input'));
        if (novoValorCentavos <= 0) {
          return interaction.editReply({ content: '❌ Valor inválido. Digite no formato exato: 0,50' });
        }

        const novoValorReais = deCentavos(novoValorCentavos);
        const novoValorPagar = await calcularValorComTaxaVirtual(novoValorReais);

        await comTrava(`match_${threadId}`, async () => {
          const atual = await db.get(`match_${threadId}`);
          if (!atual) return;
          atual.valor = novoValorReais;
          atual.valorPagar = novoValorPagar;
          await db.set(`match_${threadId}`, atual);
        });

        await interaction.channel.send({ content: `✏️ O valor da aposta foi alterado para **R$ ${formatarValorVisual(novoValorReais)}** por <@${interaction.user.id}>.` });
        return interaction.editReply({ content: '✅ Valor atualizado com sucesso!' });
      }

      if (interaction.customId === 'modal_ticket_nome') {
        if (!interaction.deferred && !interaction.replied) await interaction.deferReply({ ephemeral: true });
        const valor = interaction.fields.getTextInputValue('ticket_nome_input').trim();
        await db.set('config_ticket_nome', valor);
        return interaction.editReply({ content: `✅ Nome do painel de tickets atualizado para: **${valor}**` });
      }

      if (interaction.customId === 'modal_ticket_descricao') {
        if (!interaction.deferred && !interaction.replied) await interaction.deferReply({ ephemeral: true });
        const valor = interaction.fields.getTextInputValue('ticket_descricao_input').trim();
        await db.set('config_ticket_descricao', valor);
        return interaction.editReply({ content: '✅ Descrição do painel de tickets atualizada.' });
      }

      if (interaction.customId === 'modal_ticket_opcao') {
        if (!interaction.deferred && !interaction.replied) await interaction.deferReply({ ephemeral: true });
        const nome = interaction.fields.getTextInputValue('ticket_opcao_nome').trim();
        const canalId = interaction.fields.getTextInputValue('ticket_opcao_canal').trim().replace(/[<#>]/g, '');
        const emoji = interaction.fields.getTextInputValue('ticket_opcao_emoji').trim();

        if (!/^\d{15,25}$/.test(canalId)) {
          return interaction.editReply({ content: '❌ ID de canal inválido. Copie o ID numérico do canal (ative o Modo Desenvolvedor e clique em "Copiar ID").' });
        }

        const canalValido = await client.channels.fetch(canalId).catch(() => null);
        if (!canalValido) {
          return interaction.editReply({ content: '❌ Não encontrei nenhum canal com esse ID neste servidor.' });
        }

        await comTrava('config_ticket_opcoes', async () => {
          const opcoes = (await db.get('config_ticket_opcoes')) || [];
          opcoes.push({ nome, canalId, emoji: emoji || null });
          await db.set('config_ticket_opcoes', opcoes);
        });

        return interaction.editReply({ content: `✅ Opção **${nome}** adicionada! Os tickets dela serão criados como tópico dentro de <#${canalId}>.` });
      }

      if (interaction.customId.startsWith('modal_emoji_')) {
        if (!interaction.deferred && !interaction.replied) await interaction.deferReply({ ephemeral: true });
        const chave = interaction.customId.replace('modal_emoji_', '');
        const novoEmoji = interaction.fields.getTextInputValue('emoji_input').trim();

        await comTrava('config_emojis', async () => {
          const emojis = (await db.get('config_emojis')) || {};
          emojis[chave] = novoEmoji;
          await db.set('config_emojis', emojis);
        });

        return interaction.editReply({ content: `✅ Emoji atualizado para: ${novoEmoji}` });
      }

      if (interaction.customId.startsWith('modal_embed_')) {
        if (!interaction.deferred && !interaction.replied) await interaction.deferReply({ ephemeral: true });
        const chave = interaction.customId.replace('modal_embed_', '');
        const titulo = interaction.fields.getTextInputValue('embed_titulo_input').trim();
        const descricao = interaction.fields.getTextInputValue('embed_descricao_input').trim();

        await comTrava('config_embeds', async () => {
          const embeds = (await db.get('config_embeds')) || {};
          embeds[chave] = { titulo, descricao };
          await db.set('config_embeds', embeds);
        });

        return interaction.editReply({ content: '✅ Embed atualizada com sucesso!' });
      }

      if (interaction.customId.startsWith('modal_ticket_renomear_')) {
        if (!interaction.deferred && !interaction.replied) await interaction.deferReply({ ephemeral: true });
        const threadId = interaction.customId.replace('modal_ticket_renomear_', '');

        const ticketData = await db.get(`ticket_${threadId}`);
        if (!ticketData) return interaction.editReply({ content: 'Ticket não encontrado.' });
        if (!(await ehStaffTicket(interaction.member, interaction.guild))) {
          return interaction.editReply({ content: '❌ Você não tem permissão para isso.' });
        }

        const novoNome = interaction.fields.getTextInputValue('ticket_renomear_input').trim()
          .toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 90);
        if (!novoNome) return interaction.editReply({ content: '❌ Nome inválido.' });

        const topico = await client.channels.fetch(threadId).catch(() => null);
        if (!topico) return interaction.editReply({ content: '❌ Tópico do ticket não encontrado.' });

        await topico.setName(novoNome).catch(() => {});
        return interaction.editReply({ content: `✅ Ticket renomeado para **${novoNome}**.` });
      }

      if (interaction.customId.startsWith('modal_streamer_regras_')) {
        if (!interaction.deferred && !interaction.replied) await interaction.deferReply({ ephemeral: true });
        const chave = interaction.customId.replace('modal_streamer_regras_', '');

        const resultado = await comTrava(`streamer_${chave}`, async () => {
          const data = await db.get(`streamer_${chave}`);
          if (!data) return { erro: 'Fila não encontrada.' };
          if (!(await podeGerenciarStreamer(interaction, data))) return { erro: '❌ Você não tem permissão para isso.' };

          data.regras = interaction.fields.getTextInputValue('regras_input').trim();
          await db.set(`streamer_${chave}`, data);
          return { data };
        });

        if (resultado.erro) return interaction.editReply({ content: resultado.erro });

        await atualizarFilaStreamer(resultado.data);
        return interaction.editReply({ content: '✅ Regras da fila atualizadas.' });
      }

      if (interaction.customId === 'modal_add_valor') {
        if (!interaction.deferred && !interaction.replied) await interaction.deferReply({ ephemeral: true });
        const input = interaction.fields.getTextInputValue('valor_input');
        const numCentavos = paraCentavos(input);

        if (numCentavos <= 0) {
          return interaction.editReply({ content: '❌ Valor inválido. Digite no formato exato: 0,20' });
        }

        let valores = (await db.get('config_valores')) || [20, 50, 100, 200];
        if (!valores.includes(numCentavos)) {
          valores.push(numCentavos);
          valores.sort((a, b) => a - b);
          await db.set('config_valores', valores);
        }

        const listaFormatada = valores.map(v => formatarValorVisual(deCentavos(v))).join('\n• ');
        return interaction.editReply({ content: `✅ **Valor adicionado!**\n\nLista de valores atuais:\n• ${listaFormatada}` });
      }

      if (interaction.customId === 'modal_taxa_org') {
        if (!interaction.deferred && !interaction.replied) await interaction.deferReply({ ephemeral: true });
        const input = interaction.fields.getTextInputValue('taxa_input');
        const valorReais = parseFloat(String(input).replace(',', '.'));

        if (isNaN(valorReais) || valorReais < 0) {
          return interaction.editReply({ content: '❌ Valor de taxa inválido.' });
        }

        await db.set('config_taxa_org', valorReais);
        return interaction.editReply({ content: `✅ Taxa de referência configurada para: R$ ${formatarValorVisual(valorReais)}` });
      }

      if (interaction.customId.startsWith('modal_revanche_')) {
        if (!interaction.deferred && !interaction.replied) await interaction.deferReply({ ephemeral: true });
        const threadId = interaction.customId.replace('modal_revanche_', '');

        const matchData = await db.get(`match_${threadId}`);
        if (!matchData) {
          return interaction.editReply({ content: 'Partida não encontrada.' });
        }
        if (interaction.user.id !== matchData.mediadorId) {
          return interaction.editReply({ content: '❌ Você não tem permissão para isso.' });
        }

        const valorCentavos = paraCentavos(interaction.fields.getTextInputValue('revanche_valor'));
        if (valorCentavos <= 0) {
          return interaction.editReply({ content: '❌ Valor inválido. Digite no formato exato: 0,50' });
        }

        const mudaram = interpretarSimNao(interaction.fields.getTextInputValue('revanche_time'));
        if (mudaram === null) {
          return interaction.editReply({ content: '❌ Na pergunta sobre mudança de time, responda apenas "sim" ou "não".' });
        }

        const cadastros = (await db.get('cadastro_mediadores')) || {};
        const pix = cadastros[matchData.mediadorId];
        if (!pix) {
          return interaction.editReply({ content: '⚠️ Você não tem chave PIX cadastrada. Cadastre pelo painel do /cadastromed.' });
        }

        const valorReais = deCentavos(valorCentavos);
        const valorPagar = await calcularValorComTaxaVirtual(valorReais);

        // Nova rodada: libera o registro de um novo resultado
        const atual = (await db.get(`match_${threadId}`)) || matchData;
        atual.valor = valorReais;
        atual.valorPagar = valorPagar;
        atual.resultadoRegistrado = false;
        atual.rodada = (atual.rodada || 1) + 1;
        await db.set(`match_${threadId}`, atual);

        const rank = (await db.get('rank_mediadores')) || {};
        rank[matchData.mediadorId] = (rank[matchData.mediadorId] || 0) + 1;
        await db.set('rank_mediadores', rank);

        await interaction.channel.send({
          content: `🔁 **Revanche!** <@${matchData.p1}> <@${matchData.p2}>\n\n**Valor a pagar: R$ ${valorPagar}**\n**Mudaram de time:** ${mudaram ? 'Sim' : 'Não'}`,
          embeds: [montarEmbedPix(pix, matchData.mediadorId)]
        });

        return interaction.editReply({ content: '✅ Revanche iniciada. A chave PIX foi enviada novamente.' });
      }

      if (interaction.customId === 'modal_foto_fila') {
        if (!interaction.deferred && !interaction.replied) await interaction.deferReply({ ephemeral: true });
        const entrada = interaction.fields.getTextInputValue('foto_input').trim();

        if (entrada.toLowerCase() === 'org') {
          const icone = interaction.guild ? interaction.guild.iconURL({ size: 512 }) : null;
          if (!icone) {
            return interaction.editReply({ content: '❌ Este servidor não tem foto (ícone) definida.' });
          }
          await db.set('config_foto', 'org');
          return interaction.editReply({ content: '✅ Foto das filas configurada: foto do servidor.' });
        }

        if (!/^https?:\/\/\S+$/i.test(entrada)) {
          return interaction.editReply({ content: '❌ Link inválido. Envie um link começando com http:// ou https://, ou digite `org`.' });
        }

        await db.set('config_foto', entrada);
        return interaction.editReply({ content: '✅ Foto das filas atualizada.' });
      }

      if (interaction.customId === 'modal_cadastro_pix') {
        if (!interaction.deferred && !interaction.replied) await interaction.deferReply({ ephemeral: true });
        const titular = interaction.fields.getTextInputValue('pix_titular').trim();
        const banco = interaction.fields.getTextInputValue('pix_banco').trim();
        const chave = interaction.fields.getTextInputValue('pix_chave').trim();

        if (!titular || !banco || !chave) {
          return interaction.editReply({ content: '❌ Preencha todos os campos.' });
        }

        const cadastros = (await db.get('cadastro_mediadores')) || {};
        cadastros[interaction.user.id] = { titular, banco, chave };
        await db.set('cadastro_mediadores', cadastros);

        return interaction.editReply({ content: '✅ Chave PIX cadastrada com sucesso! Agora você já pode entrar na fila de mediadores.' });
      }

      if (interaction.customId === 'modal_cor_hex') {
        if (!interaction.deferred && !interaction.replied) await interaction.deferReply({ ephemeral: true });
        const hex = interaction.fields.getTextInputValue('cor_input');
        if (!/^#([0-9A-F]{3}){1,2}$/i.test(hex)) {
          return interaction.editReply({ content: '❌ Formato HEX inválido. Exemplo correto: #FF0000' });
        }
        await db.set('config_cor_hex', hex);
        return interaction.editReply({ content: `✅ Cor da organização atualizada para: \`${hex}\`` });
      }

      if (interaction.customId === 'modal_embedcustom_titulo') {
        const rascunho = obterRascunhoEmbed(interaction.user.id);
        const valor = interaction.fields.getTextInputValue('embedcustom_titulo_input').trim();
        rascunho.titulo = valor || null;
        return interaction.update(montarPainelEmbedCustom(interaction.user.id));
      }

      if (interaction.customId === 'modal_embedcustom_descricao') {
        const rascunho = obterRascunhoEmbed(interaction.user.id);
        const valor = interaction.fields.getTextInputValue('embedcustom_descricao_input');
        rascunho.descricao = (valor && valor.trim()) ? valor : null;
        return interaction.update(montarPainelEmbedCustom(interaction.user.id));
      }

      if (interaction.customId === 'modal_embedcustom_cor') {
        const rascunho = obterRascunhoEmbed(interaction.user.id);
        const hex = interaction.fields.getTextInputValue('embedcustom_cor_input').trim();
        if (hex && !/^#([0-9A-F]{3}){1,2}$/i.test(hex)) {
          return interaction.reply({ content: '❌ Formato HEX inválido. Exemplo correto: #FF0000', ephemeral: true });
        }
        rascunho.cor = hex || null;
        return interaction.update(montarPainelEmbedCustom(interaction.user.id));
      }

      if (interaction.customId === 'modal_embedcustom_imagem') {
        const rascunho = obterRascunhoEmbed(interaction.user.id);
        const valor = interaction.fields.getTextInputValue('embedcustom_imagem_input').trim();
        rascunho.imagem = valor || null;
        return interaction.update(montarPainelEmbedCustom(interaction.user.id));
      }

      if (interaction.customId === 'modal_embedcustom_thumbnail') {
        const rascunho = obterRascunhoEmbed(interaction.user.id);
        const valor = interaction.fields.getTextInputValue('embedcustom_thumbnail_input').trim();
        rascunho.thumbnail = valor || null;
        return interaction.update(montarPainelEmbedCustom(interaction.user.id));
      }
    }

    if (interaction.isStringSelectMenu()) {
      if (interaction.customId.startsWith('med_menu_')) {
        const threadId = interaction.customId.replace('med_menu_', '');
        const matchData = await carregarApostaDoMediador(interaction, threadId);
        if (!matchData) return;

        const acao = interaction.values[0];

        if (acao === 'vencedor' || acao === 'wo') {
          if (matchData.confirmations.length < 2) {
            return interaction.reply({ content: '⚠️ Aguarde os dois jogadores confirmarem a aposta.', ephemeral: true });
          }
          if (matchData.resultadoRegistrado) {
            return interaction.reply({ content: '⚠️ O resultado desta aposta já foi registrado. Use Revanche ou Finalizar Aposta.', ephemeral: true });
          }

          const tipo = acao === 'wo' ? 'wo' : 'vit';
          const rowJogadores = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId(`med_res_${tipo}_${threadId}_1`).setLabel('Jogador 1').setStyle(ButtonStyle.Primary),
            new ButtonBuilder().setCustomId(`med_res_${tipo}_${threadId}_2`).setLabel('Jogador 2').setStyle(ButtonStyle.Primary)
          );

          const pergunta = tipo === 'wo' ? '🚩 **Quem ganhou por W.O.?**' : '🏆 **Quem venceu?**';
          return interaction.reply({
            content: `${pergunta}\n\n1️⃣ <@${matchData.p1}>\n2️⃣ <@${matchData.p2}>`,
            components: [rowJogadores],
            ephemeral: true
          });
        }

        if (acao === 'finalizar') {
          await db.delete(`match_${threadId}`);
          if (!interaction.deferred && !interaction.replied) await interaction.deferUpdate();
          await interaction.channel.send({ content: `✅ Aposta finalizada por <@${interaction.user.id}>. Este tópico será apagado em 5 segundos.` });
          setTimeout(() => interaction.channel.delete().catch(() => {}), 5000);
          return;
        }

        if (acao === 'revanche') {
          if (matchData.confirmations.length < 2) {
            return interaction.reply({ content: '⚠️ Aguarde os dois jogadores confirmarem a aposta.', ephemeral: true });
          }

          const modal = new ModalBuilder().setCustomId(`modal_revanche_${threadId}`).setTitle('Revanche');
          const inputValor = new TextInputBuilder()
            .setCustomId('revanche_valor')
            .setLabel('Valor da revanche (Ex: 0,50)')
            .setStyle(TextInputStyle.Short)
            .setPlaceholder('0,50')
            .setRequired(true);
          const inputTime = new TextInputBuilder()
            .setCustomId('revanche_time')
            .setLabel('Os jogadores mudaram de time? (sim/não)')
            .setStyle(TextInputStyle.Short)
            .setPlaceholder('sim ou não')
            .setMaxLength(3)
            .setRequired(true);
          modal.addComponents(
            new ActionRowBuilder().addComponents(inputValor),
            new ActionRowBuilder().addComponents(inputTime)
          );
          return interaction.showModal(modal);
        }

        if (acao === 'alterar_valor') {
          return interaction.showModal(montarModalAlterarValor(threadId, matchData.valor));
        }

        if (acao === 'liberar_chave') {
          const cadastros = (await db.get('cadastro_mediadores')) || {};
          const pix = cadastros[matchData.mediadorId];
          if (!pix) {
            return interaction.reply({ content: '⚠️ Você não tem chave PIX cadastrada. Cadastre pelo painel do /cadastromed.', ephemeral: true });
          }

          const valorPagar = matchData.valorPagar || await calcularValorComTaxaVirtual(matchData.valor);
          const valorNumerico = parseFloat(String(valorPagar).replace(',', '.')) || matchData.valor;
          const qrBuffer = await gerarQrCodePixBuffer(pix, valorNumerico);

          if (!interaction.deferred && !interaction.replied) await interaction.deferUpdate();

          const conteudoChave = `**Valor a pagar: R$ ${valorPagar}**\n\n**Nome:** ${pix.titular}\n**Chave:** \`${pix.chave}\`\n**Qrcode:**`;
          const opcoesEnvio = { content: conteudoChave };
          if (qrBuffer) opcoesEnvio.files = [new AttachmentBuilder(qrBuffer, { name: 'qrcode-pix.png' })];

          await interaction.channel.send(opcoesEnvio);
          return;
        }

        return;
      }

      if (interaction.customId === 'ticket_selecionar_opcao') {
        if (!interaction.deferred && !interaction.replied) await interaction.deferUpdate();

        const idx = parseInt(interaction.values[0], 10);
        const opcoes = (await db.get('config_ticket_opcoes')) || [];
        const opcao = opcoes[idx];
        if (!opcao) {
          return interaction.followUp({ content: '⚠️ Essa opção não existe mais.', ephemeral: true });
        }

        // Se o usuário já tem um ticket em aberto, devolve o acesso a ele em vez de criar outro
        const abertoId = await db.get(`ticket_aberto_${interaction.user.id}`);
        if (abertoId) {
          const topicoExistente = await client.channels.fetch(abertoId).catch(() => null);
          if (topicoExistente) {
            await reabrirTicketExistente(topicoExistente, interaction.user);
            return interaction.followUp({ content: `⚠️ Você já tem um ticket aberto: <#${abertoId}>. Te devolvi o acesso a ele.`, ephemeral: true });
          }
          await db.delete(`ticket_aberto_${interaction.user.id}`).catch(() => {});
        }

        const { canal, erro } = await criarCanalDeTicket(interaction.guild, interaction.user, opcao);
        if (erro) {
          return interaction.followUp({ content: erro, ephemeral: true });
        }

        const corHex = await corPadrao();
        const embedTicket = montarEmbedTicketCanal(interaction.guild, interaction.user, opcao.nome, corHex);
        const rowBotoes = await montarBotoesTicket(canal.id);

        await canal.send({ content: `<@${interaction.user.id}>`, embeds: [embedTicket], components: [rowBotoes] });

        await db.set(`ticket_${canal.id}`, {
          threadId: canal.id,
          userId: interaction.user.id,
          opcaoNome: opcao.nome,
          assumidoPor: null
        });
        await db.set(`ticket_aberto_${interaction.user.id}`, canal.id);

        return interaction.followUp({ content: `✅ Ticket criado: <#${canal.id}>`, ephemeral: true });
      }

      if (interaction.customId === 'select_ticket_remover_opcao') {
        if (!(await ehAdmin(interaction))) {
          return interaction.reply({ content: '❌ Você não tem permissão para usar esta opção.', ephemeral: true });
        }
        if (!interaction.deferred && !interaction.replied) await interaction.deferUpdate();

        const idx = parseInt(interaction.values[0], 10);
        const removida = await comTrava('config_ticket_opcoes', async () => {
          const opcoes = (await db.get('config_ticket_opcoes')) || [];
          const alvo = opcoes[idx];
          if (!alvo) return null;
          opcoes.splice(idx, 1);
          await db.set('config_ticket_opcoes', opcoes);
          return alvo;
        });

        if (!removida) return interaction.editReply({ content: '⚠️ Essa opção não existe mais.', components: [] });
        return interaction.editReply({ content: `✅ Opção **${removida.nome}** removida.`, components: [] });
      }

      if (interaction.customId.startsWith('select_personalizar_emoji')) {
        const chave = interaction.values[0];
        const cfg = EMOJIS_EDITAVEIS[chave];
        if (!cfg) return interaction.reply({ content: 'Opção inválida.', ephemeral: true });

        const atual = await obterEmoji(chave, cfg.padrao);

        const modal = new ModalBuilder().setCustomId(`modal_emoji_${chave}`).setTitle('Trocar Emoji');
        const input = new TextInputBuilder()
          .setCustomId('emoji_input')
          .setLabel(`Novo emoji para: ${cfg.label}`.slice(0, 45))
          .setStyle(TextInputStyle.Short)
          .setPlaceholder('Cole um emoji unicode ou de servidor')
          .setValue(atual || '')
          .setMaxLength(100)
          .setRequired(true);
        modal.addComponents(new ActionRowBuilder().addComponents(input));
        return interaction.showModal(modal);
      }

      if (interaction.customId === 'select_personalizar_embed') {
        const chave = interaction.values[0];
        const cfg = EMBEDS_EDITAVEIS[chave];
        if (!cfg) return interaction.reply({ content: 'Opção inválida.', ephemeral: true });

        const atual = await obterTextoEmbed(chave);

        const modal = new ModalBuilder().setCustomId(`modal_embed_${chave}`).setTitle(cfg.label.slice(0, 45));
        const inputTitulo = new TextInputBuilder()
          .setCustomId('embed_titulo_input')
          .setLabel('Título da embed')
          .setStyle(TextInputStyle.Short)
          .setValue(atual.titulo.slice(0, 256))
          .setMaxLength(256)
          .setRequired(true);
        const inputDescricao = new TextInputBuilder()
          .setCustomId('embed_descricao_input')
          .setLabel('Descrição da embed')
          .setStyle(TextInputStyle.Paragraph)
          .setValue(atual.descricao.slice(0, 1000))
          .setMaxLength(1000)
          .setRequired(true);
        modal.addComponents(
          new ActionRowBuilder().addComponents(inputTitulo),
          new ActionRowBuilder().addComponents(inputDescricao)
        );
        return interaction.showModal(modal);
      }

      if (interaction.customId === 'select_modalidade_criar') {
        if (!interaction.deferred && !interaction.replied) await interaction.deferReply({ ephemeral: true });

        const modalidadeEscolhida = interaction.values[0];
        const valoresCentavos = [...((await db.get('config_valores')) || [20, 50, 100, 200])]
          .sort((a, b) => b - a); // maior valor primeiro, menor valor por último
        const foto = await resolverFoto(interaction.guild);
        const imagem = await db.get('config_imagem');

        const is1v1 = modalidadeEscolhida.toLowerCase().startsWith('1x1');
        const isMisto = modalidadeEscolhida.toLowerCase().includes('misto');
        const tamanhoTime = parseInt(modalidadeEscolhida, 10) || 2; // 2x2 -> 2, 3x3 -> 3, 4x4 -> 4

        const emojiNormal = await obterEmoji('entrar_normal', '🎮');
        const emojiUmp = await obterEmoji('entrar_ump', '🔥');
        const emojiGeloNormal = await obterEmoji('entrar_gelo_normal', '🎮');
        const emojiGeloInfinito = await obterEmoji('entrar_gelo_infinito', '♾️');
        const emojiEmu = await obterEmoji('entrar_emu', '🖥️');
        const emojiSair = await obterEmoji('sair_fila', '❌');

        for (const valCentavos of valoresCentavos) {
          const valReais = deCentavos(valCentavos);
          const embedFila = criarEmbedFila(modalidadeEscolhida, valReais, [], foto, imagem);

          let rowFila;
          if (is1v1) {
            rowFila = new ActionRowBuilder().addComponents(
              new ButtonBuilder().setCustomId(`entrar_gelo_normal_${valCentavos}`).setLabel('Gelo Normal').setStyle(ButtonStyle.Secondary).setEmoji(emojiGeloNormal),
              new ButtonBuilder().setCustomId(`entrar_gelo_infinito_${valCentavos}`).setLabel('Gelo Infinito').setStyle(ButtonStyle.Secondary).setEmoji(emojiGeloInfinito),
              new ButtonBuilder().setCustomId(`sair_${valCentavos}`).setLabel('Sair').setStyle(ButtonStyle.Danger).setEmoji(emojiSair)
            );
          } else if (isMisto) {
            // Misto: 2x2 = 1 Emu | 3x3 = 1 Emu e 2 Emu | 4x4 = 1, 2 e 3 Emu | e o botão Sair
            const botoesMisto = [];
            for (let n = 1; n < tamanhoTime; n++) {
              botoesMisto.push(
                new ButtonBuilder().setCustomId(`entrar_emu${n}_${valCentavos}`).setLabel(`${n} Emu`).setStyle(ButtonStyle.Secondary).setEmoji(emojiEmu)
              );
            }
            botoesMisto.push(new ButtonBuilder().setCustomId(`sair_${valCentavos}`).setLabel('Sair').setStyle(ButtonStyle.Danger).setEmoji(emojiSair));
            rowFila = new ActionRowBuilder().addComponents(botoesMisto);
          } else {
            rowFila = new ActionRowBuilder().addComponents(
              new ButtonBuilder().setCustomId(`entrar_normal_${valCentavos}`).setLabel('Normal').setStyle(ButtonStyle.Success).setEmoji(emojiNormal),
              new ButtonBuilder().setCustomId(`entrar_ump_${valCentavos}`).setLabel('Full UMP e XM8').setStyle(ButtonStyle.Secondary).setEmoji(emojiUmp),
              new ButtonBuilder().setCustomId(`sair_${valCentavos}`).setLabel('Sair').setStyle(ButtonStyle.Danger).setEmoji(emojiSair)
            );
          }

          const msg = await interaction.channel.send({ embeds: [embedFila], components: [rowFila] });
          await db.set(`fila_${msg.id}`, {
            channelId: interaction.channel.id,
            modalidade: modalidadeEscolhida,
            valor: valReais,
            jogadores: []
          });
        }

        return interaction.editReply({ content: `✅ Filas para **${modalidadeEscolhida}** criadas com sucesso para todos os valores configurados!` });
      }

      if (interaction.customId === 'filamed_remover_select') {
        if (!(await ehAdmin(interaction))) {
          return interaction.reply({ content: '❌ Você não tem permissão para usar esta opção.', ephemeral: true });
        }

        const removerId = interaction.values[0];
        await comTrava('mediadores', async () => {
          const fila = (await db.get('fila_mediadores_fifo')) || [];
          await db.set('fila_mediadores_fifo', fila.filter(m => m !== removerId));
        });

        await interaction.update({ content: `✅ <@${removerId}> foi removido da fila de mediadores.`, components: [] });
        await atualizarPaineisFilaMed();
        return;
      }

      if (interaction.customId === 'select_remover_valor') {
        if (!interaction.deferred && !interaction.replied) await interaction.deferReply({ ephemeral: true });
        const valParaRemover = parseInt(interaction.values[0], 10);

        let valores = (await db.get('config_valores')) || [];
        valores = valores.filter(v => v !== valParaRemover);
        await db.set('config_valores', valores);

        return interaction.editReply({ content: `✅ Valor R$ ${formatarValorVisual(deCentavos(valParaRemover))} removido com sucesso!` });
      }

      if (interaction.customId.startsWith('select_streamer_modo_')) {
        const chave = interaction.customId.replace('select_streamer_modo_', '');
        const novoModo = interaction.values[0];

        const resultado = await comTrava(`streamer_${chave}`, async () => {
          const dados = await db.get(`streamer_${chave}`);
          if (!dados) return { erro: 'Fila não encontrada.' };
          if (!(await podeGerenciarStreamer(interaction, dados))) return { erro: '❌ Você não tem permissão para isso.' };
          dados.modo = novoModo;
          await db.set(`streamer_${chave}`, dados);
          return { dados };
        });

        if (resultado.erro) return interaction.update({ content: resultado.erro, components: [] });

        await interaction.update({ content: `✅ Modo definido: **${novoModo}**`, components: [] });
        await atualizarFilaStreamer(resultado.dados);
        return;
      }

      if (interaction.customId.startsWith('select_streamer_puxar_')) {
        const chave = interaction.customId.replace('select_streamer_puxar_', '');
        const idsSelecionados = interaction.values;

        const resultado = await comTrava(`streamer_${chave}`, async () => {
          const dados = await db.get(`streamer_${chave}`);
          if (!dados) return { erro: 'Fila não encontrada.' };
          if (!(await podeGerenciarStreamer(interaction, dados))) return { erro: '❌ Você não tem permissão para isso.' };

          const faltando = idsSelecionados.some(id => !dados.jogadores.includes(id));
          if (faltando) return { erro: '⚠️ Um ou mais jogadores selecionados saíram da fila. Tente novamente.' };

          const mediadorId = await pegarMediadorEGirar();
          if (!mediadorId) return { erro: '⚠️ Não há mediadores online no momento. Aguarde um mediador entrar na fila.' };

          dados.jogadores = dados.jogadores.filter(uid => !idsSelecionados.includes(uid));
          await db.set(`streamer_${chave}`, dados);

          return { dados, puxados: idsSelecionados, mediadorId };
        });

        if (resultado.erro) return interaction.update({ content: resultado.erro, components: [] });

        const { dados, puxados, mediadorId } = resultado;
        await interaction.update({ content: '⏳ Criando o tópico da partida...', components: [] });

        // O tópico da partida contra o streamer nasce exatamente igual ao das filas normais:
        // mesmo canal de tópicos configurado, mesma embed "Aguardando Confirmações", os mesmos
        // botões Confirmar/Cancelar e o mesmo registro match_ (o que já libera .med, resultado,
        // ranking e Liberar Chave para o mediador automaticamente).
        const p1 = puxados[0];
        const p2 = dados.streamerId;
        const extras = puxados.slice(1);

        const canalTopicosId = await db.get('config_canal_topicos');
        let canalTopicos = interaction.channel;
        if (canalTopicosId) {
          const configurado = await client.channels.fetch(canalTopicosId).catch(() => null);
          if (configurado) canalTopicos = configurado;
        }

        let thread;
        try {
          thread = await canalTopicos.threads.create({
            name: `partida-${p1.slice(-4)}-vs-${p2.slice(-4)}`,
            autoArchiveDuration: 60,
            type: ChannelType.PrivateThread,
            reason: 'Partida contra streamer criada'
          });
        } catch (e) {
          console.error('Erro ao criar o tópico da partida contra streamer:', e);
          await devolverJogadoresStreamer(chave, puxados, mediadorId);
          await interaction.followUp({ content: '❌ Não consegui criar o tópico da partida. Confira se o bot pode criar tópicos privados nesse canal.', ephemeral: true });
          return;
        }

        for (const uid of puxados) await thread.members.add(uid).catch(() => {});
        await thread.members.add(p2).catch(() => {});
        await thread.members.add(mediadorId).catch(() => {});

        const numeroPartida = await proximoNumeroPartida();

        await db.set(`match_${thread.id}`, {
          numero: numeroPartida,
          p1,
          p2,
          jogadoresExtras: extras,
          mediadorId,
          regra: dados.modo || '1x1 MOB',
          modalidade: 'Contra Streamer',
          valor: 0,
          valorPagar: '0,00',
          confirmations: []
        });

        const matchEmbed = new EmbedBuilder()
          .setDescription(
            `## Aguardando Confirmações\n\n` +
            `🎮 **Modo**\nContra Streamer | ${dados.modo || '1x1 MOB'}\n\n` +
            `👤 **Jogadores**\n${puxados.map(uid => `<@${uid}>`).join('\n')}\n\n` +
            `👑 **Streamer**\n<@${p2}>\n\n` +
            `🛡️ **Mediador**\n<@${mediadorId}>` +
            (dados.regras ? `\n\n**Regras:**\n${dados.regras}` : '')
          )
          .setColor(await corPadrao());

        const rowButtons = await montarBotoesPartida(thread.id);

        await thread.send({
          content: `${puxados.map(uid => `<@${uid}>`).join(' ')} <@${p2}> <@${mediadorId}>`,
          embeds: [matchEmbed],
          components: [rowButtons]
        });

        await atualizarFilaStreamer(dados);
        await interaction.followUp({ content: `✅ Tópico da partida criado: <#${thread.id}>`, ephemeral: true });
        return;
      }
    }

    // Adicionar membro a um ticket (painel staff)
    if (interaction.isUserSelectMenu() && interaction.customId.startsWith('select_ticket_adicionar_')) {
      const threadId = interaction.customId.replace('select_ticket_adicionar_', '');
      if (!(await ehStaffTicket(interaction.member, interaction.guild))) {
        return interaction.update({ content: '❌ Você não tem permissão para isso.', components: [] });
      }

      const topico = await client.channels.fetch(threadId).catch(() => null);
      if (!topico) return interaction.update({ content: '❌ Tópico do ticket não encontrado.', components: [] });

      const novoId = interaction.values[0];
      await topico.members.add(novoId).catch(() => {});

      return interaction.update({ content: `✅ <@${novoId}> foi adicionado ao ticket.`, components: [] });
    }

    if (interaction.isButton()) {
      const id = interaction.customId;

      // ---------- CONFIGURAÇÃO DO SISTEMA DE TICKETS (/configticket) ----------

      if (id === 'ticket_config_nome') {
        if (!(await ehAdmin(interaction))) {
          return interaction.reply({ content: '❌ Você não tem permissão para usar esta opção.', ephemeral: true });
        }
        const modal = new ModalBuilder().setCustomId('modal_ticket_nome').setTitle('Nome do Painel de Tickets');
        const input = new TextInputBuilder()
          .setCustomId('ticket_nome_input')
          .setLabel('Nome (título da embed)')
          .setStyle(TextInputStyle.Short)
          .setPlaceholder('Ex: 🎫 Central de Tickets')
          .setMaxLength(256)
          .setRequired(true);
        modal.addComponents(new ActionRowBuilder().addComponents(input));
        return interaction.showModal(modal);
      }

      if (id === 'ticket_config_descricao') {
        if (!(await ehAdmin(interaction))) {
          return interaction.reply({ content: '❌ Você não tem permissão para usar esta opção.', ephemeral: true });
        }
        const modal = new ModalBuilder().setCustomId('modal_ticket_descricao').setTitle('Descrição do Painel de Tickets');
        const input = new TextInputBuilder()
          .setCustomId('ticket_descricao_input')
          .setLabel('Descrição da embed')
          .setStyle(TextInputStyle.Paragraph)
          .setPlaceholder('Ex: Para obter atendimento, selecione uma opção abaixo.')
          .setMaxLength(1000)
          .setRequired(true);
        modal.addComponents(new ActionRowBuilder().addComponents(input));
        return interaction.showModal(modal);
      }

      if (id === 'ticket_config_setores') {
        if (!(await ehAdmin(interaction))) {
          return interaction.reply({ content: '❌ Você não tem permissão para usar esta opção.', ephemeral: true });
        }
        if (!interaction.deferred && !interaction.replied) await interaction.deferReply({ ephemeral: true });
        const select = new ChannelSelectMenuBuilder()
          .setCustomId('select_ticket_setores')
          .setPlaceholder('Selecione os canais de texto dos setores')
          .setChannelTypes(ChannelType.GuildText)
          .setMinValues(1)
          .setMaxValues(25);
        return interaction.editReply({
          content: '🗂️ **Selecione os canais de texto que podem ser usados como destino dos tickets** (os tópicos nascem dentro deles):',
          components: [new ActionRowBuilder().addComponents(select)]
        });
      }

      if (id === 'ticket_config_opcao') {
        if (!(await ehAdmin(interaction))) {
          return interaction.reply({ content: '❌ Você não tem permissão para usar esta opção.', ephemeral: true });
        }
        const modal = new ModalBuilder().setCustomId('modal_ticket_opcao').setTitle('Nova Opção de Ticket');
        const inputNome = new TextInputBuilder()
          .setCustomId('ticket_opcao_nome')
          .setLabel('Nome da opção')
          .setStyle(TextInputStyle.Short)
          .setPlaceholder('Ex: Suporte')
          .setMaxLength(100)
          .setRequired(true);
        const inputCanal = new TextInputBuilder()
          .setCustomId('ticket_opcao_canal')
          .setLabel('ID do canal de texto onde o ticket abre')
          .setStyle(TextInputStyle.Short)
          .setPlaceholder('Ex: 123456789012345678')
          .setMaxLength(25)
          .setRequired(true);
        const inputEmoji = new TextInputBuilder()
          .setCustomId('ticket_opcao_emoji')
          .setLabel('Emoji da opção (opcional)')
          .setStyle(TextInputStyle.Short)
          .setPlaceholder('Cole um emoji unicode ou de servidor')
          .setMaxLength(100)
          .setRequired(false);
        modal.addComponents(
          new ActionRowBuilder().addComponents(inputNome),
          new ActionRowBuilder().addComponents(inputCanal),
          new ActionRowBuilder().addComponents(inputEmoji)
        );
        return interaction.showModal(modal);
      }

      if (id === 'ticket_config_remover_opcao') {
        if (!(await ehAdmin(interaction))) {
          return interaction.reply({ content: '❌ Você não tem permissão para usar esta opção.', ephemeral: true });
        }
        const opcoes = (await db.get('config_ticket_opcoes')) || [];
        if (opcoes.length === 0) {
          return interaction.reply({ content: '⚠️ Não existem opções cadastradas para remover.', ephemeral: true });
        }

        const select = new StringSelectMenuBuilder()
          .setCustomId('select_ticket_remover_opcao')
          .setPlaceholder('Selecione a opção que deseja remover')
          .addOptions(opcoes.slice(0, 25).map((op, i) => ({ label: op.nome.slice(0, 100), value: String(i) })));

        return interaction.reply({ content: '🗑️ **Selecione a opção que deseja remover:**', components: [new ActionRowBuilder().addComponents(select)], ephemeral: true });
      }

      if (id === 'ticket_config_staff') {
        if (!(await ehAdmin(interaction))) {
          return interaction.reply({ content: '❌ Você não tem permissão para usar esta opção.', ephemeral: true });
        }
        if (!interaction.deferred && !interaction.replied) await interaction.deferReply({ ephemeral: true });
        const select = new RoleSelectMenuBuilder()
          .setCustomId('select_ticket_staff_cargos')
          .setPlaceholder('Selecione o(s) cargo(s) da equipe de tickets')
          .setMinValues(1)
          .setMaxValues(25);
        return interaction.editReply({
          content: '🛡️ **Quais cargos podem Finalizar, Assumir e usar o Painel Staff dentro dos tickets?**',
          components: [new ActionRowBuilder().addComponents(select)]
        });
      }

      if (id === 'ticket_config_publicar') {
        if (!(await ehAdmin(interaction))) {
          return interaction.reply({ content: '❌ Você não tem permissão para usar esta opção.', ephemeral: true });
        }
        if (!interaction.deferred && !interaction.replied) await interaction.deferReply({ ephemeral: true });
        await interaction.channel.send(await montarEmbedTicketPrincipal(interaction.guild));
        return interaction.editReply({ content: '✅ Painel de tickets publicado neste canal.' });
      }

      // ---------- BOTÕES DENTRO DO TICKET ----------

      if (id.startsWith('ticket_finalizar_')) {
        const threadId = id.replace('ticket_finalizar_', '');
        if (!(await ehStaffTicket(interaction.member, interaction.guild))) {
          return interaction.reply({ content: '❌ Você não tem permissão para isso.', ephemeral: true });
        }

        if (!interaction.deferred && !interaction.replied) await interaction.deferUpdate();

        const ticketData = await db.get(`ticket_${threadId}`);
        if (ticketData) {
          await db.delete(`ticket_${threadId}`).catch(() => {});
          const abertoId = await db.get(`ticket_aberto_${ticketData.userId}`);
          if (abertoId === threadId) await db.delete(`ticket_aberto_${ticketData.userId}`).catch(() => {});
        }

        await interaction.channel.send({ content: `✅ Ticket finalizado por <@${interaction.user.id}>. Este tópico será apagado em 5 segundos.` });
        setTimeout(() => interaction.channel.delete().catch(() => {}), 5000);
        return;
      }

      if (id.startsWith('ticket_assumir_')) {
        const threadId = id.replace('ticket_assumir_', '');
        if (!(await ehStaffTicket(interaction.member, interaction.guild))) {
          return interaction.reply({ content: '❌ Você não tem permissão para isso.', ephemeral: true });
        }

        await comTrava(`ticket_${threadId}`, async () => {
          const ticketData = await db.get(`ticket_${threadId}`);
          if (!ticketData) return;
          ticketData.assumidoPor = interaction.user.id;
          await db.set(`ticket_${threadId}`, ticketData);
        });

        if (!interaction.deferred && !interaction.replied) await interaction.deferUpdate();
        await interaction.channel.send({ content: `<@${interaction.user.id}> assumiu este ticket.` });
        return;
      }

      if (id.startsWith('ticket_painel_staff_')) {
        const threadId = id.replace('ticket_painel_staff_', '');
        if (!(await ehStaffTicket(interaction.member, interaction.guild))) {
          return interaction.reply({ content: '❌ Você não tem permissão para isso.', ephemeral: true });
        }

        const row = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId(`ticket_renomear_${threadId}`).setLabel('Renomear Ticket').setStyle(ButtonStyle.Primary).setEmoji('✏️'),
          new ButtonBuilder().setCustomId(`ticket_adicionar_${threadId}`).setLabel('Adicionar Membro').setStyle(ButtonStyle.Success).setEmoji('➕')
        );

        return interaction.reply({ content: '🛡️ **Painel Staff:**', components: [row], ephemeral: true });
      }

      if (id.startsWith('ticket_renomear_')) {
        const threadId = id.replace('ticket_renomear_', '');
        if (!(await ehStaffTicket(interaction.member, interaction.guild))) {
          return interaction.reply({ content: '❌ Você não tem permissão para isso.', ephemeral: true });
        }

        const modal = new ModalBuilder().setCustomId(`modal_ticket_renomear_${threadId}`).setTitle('Renomear Ticket');
        const input = new TextInputBuilder()
          .setCustomId('ticket_renomear_input')
          .setLabel('Novo nome do tópico')
          .setStyle(TextInputStyle.Short)
          .setPlaceholder('Ex: suporte-drizinhu')
          .setMaxLength(90)
          .setRequired(true);
        modal.addComponents(new ActionRowBuilder().addComponents(input));
        return interaction.showModal(modal);
      }

      if (id.startsWith('ticket_adicionar_')) {
        const threadId = id.replace('ticket_adicionar_', '');
        if (!(await ehStaffTicket(interaction.member, interaction.guild))) {
          return interaction.reply({ content: '❌ Você não tem permissão para isso.', ephemeral: true });
        }

        const select = new UserSelectMenuBuilder()
          .setCustomId(`select_ticket_adicionar_${threadId}`)
          .setPlaceholder('Selecione o usuário para adicionar')
          .setMinValues(1)
          .setMaxValues(1);

        return interaction.reply({ content: '➕ **Quem deseja adicionar a este ticket?**', components: [new ActionRowBuilder().addComponents(select)], ephemeral: true });
      }

      if (id.startsWith('ticket_sair_')) {
        const threadId = id.replace('ticket_sair_', '');
        const ticketData = await db.get(`ticket_${threadId}`);
        if (!ticketData) {
          return interaction.reply({ content: 'Ticket não encontrado.', ephemeral: true });
        }
        if (interaction.user.id !== ticketData.userId) {
          return interaction.reply({ content: '❌ Só quem abriu o ticket pode sair dele.', ephemeral: true });
        }

        if (!interaction.deferred && !interaction.replied) await interaction.deferUpdate();

        // Remove o usuário do tópico, mas mantém o ticket registrado: se ele tentar abrir outro
        // ticket depois, o bot devolve o acesso a este mesmo tópico em vez de criar um novo.
        await interaction.channel.members.remove(interaction.user.id).catch(() => {});
        await interaction.channel.send({ content: `↪️ <@${interaction.user.id}> saiu deste ticket.` });
        return;
      }

      // ---------- SALA CRIADA (dentro da partida) ----------

      if (id.startsWith('sala_copiar_id_')) {
        const threadId = id.replace('sala_copiar_id_', '');
        const matchData = await db.get(`match_${threadId}`);
        if (!matchData || !matchData.salaId) {
          return interaction.reply({ content: 'ID da sala não encontrado.', ephemeral: true });
        }
        return interaction.reply({ content: `\`${matchData.salaId}\``, ephemeral: true });
      }

      if (id.startsWith('sala_alterar_valor_')) {
        const threadId = id.replace('sala_alterar_valor_', '');
        const matchData = await carregarApostaDoMediador(interaction, threadId);
        if (!matchData) return;
        return interaction.showModal(montarModalAlterarValor(threadId, matchData.valor));
      }

      // ---------- PERSONALIZAÇÃO DO BOT (.d / /embed) ----------

      if (id === 'personalizar_emojis') {
        if (!interaction.deferred && !interaction.replied) await interaction.deferReply({ ephemeral: true });
        return interaction.editReply({ content: '😀 Selecione o botão que deseja trocar o emoji (aceita emojis do servidor):', components: montarSelectsEmojis() });
      }

      if (id === 'personalizar_embed') {
        if (!interaction.deferred && !interaction.replied) await interaction.deferReply({ ephemeral: true });
        return interaction.editReply({ content: '🖼️ Selecione a embed que deseja editar:', components: [montarSelectEmbeds()] });
      }

      // ---------- CONSTRUTOR DE EMBED PERSONALIZADA (/embed) ----------

      if (id === 'embedcustom_titulo') {
        const rascunho = obterRascunhoEmbed(interaction.user.id);
        const modal = new ModalBuilder().setCustomId('modal_embedcustom_titulo').setTitle('Título da Embed');
        const input = new TextInputBuilder()
          .setCustomId('embedcustom_titulo_input')
          .setLabel('Título (deixe vazio para remover)')
          .setStyle(TextInputStyle.Short)
          .setMaxLength(256)
          .setRequired(false);
        if (rascunho.titulo) input.setValue(rascunho.titulo);
        modal.addComponents(new ActionRowBuilder().addComponents(input));
        return interaction.showModal(modal);
      }

      if (id === 'embedcustom_descricao') {
        const rascunho = obterRascunhoEmbed(interaction.user.id);
        const modal = new ModalBuilder().setCustomId('modal_embedcustom_descricao').setTitle('Descrição da Embed');
        const input = new TextInputBuilder()
          .setCustomId('embedcustom_descricao_input')
          .setLabel('Descrição (emojis, # título, @/# menções)')
          .setStyle(TextInputStyle.Paragraph)
          .setMaxLength(4000)
          .setRequired(false);
        if (rascunho.descricao) input.setValue(rascunho.descricao);
        modal.addComponents(new ActionRowBuilder().addComponents(input));
        return interaction.showModal(modal);
      }

      if (id === 'embedcustom_cor') {
        const rascunho = obterRascunhoEmbed(interaction.user.id);
        const modal = new ModalBuilder().setCustomId('modal_embedcustom_cor').setTitle('Cor da Embed');
        const input = new TextInputBuilder()
          .setCustomId('embedcustom_cor_input')
          .setLabel('Código HEX (Ex: #FF0000, vazio = padrão)')
          .setStyle(TextInputStyle.Short)
          .setMaxLength(7)
          .setRequired(false);
        if (rascunho.cor) input.setValue(rascunho.cor);
        modal.addComponents(new ActionRowBuilder().addComponents(input));
        return interaction.showModal(modal);
      }

      if (id === 'embedcustom_imagem') {
        const rascunho = obterRascunhoEmbed(interaction.user.id);
        const modal = new ModalBuilder().setCustomId('modal_embedcustom_imagem').setTitle('Imagem da Embed');
        const input = new TextInputBuilder()
          .setCustomId('embedcustom_imagem_input')
          .setLabel('Link da imagem (deixe vazio para remover)')
          .setStyle(TextInputStyle.Short)
          .setRequired(false);
        if (rascunho.imagem) input.setValue(rascunho.imagem);
        modal.addComponents(new ActionRowBuilder().addComponents(input));
        return interaction.showModal(modal);
      }

      if (id === 'embedcustom_thumbnail') {
        const rascunho = obterRascunhoEmbed(interaction.user.id);
        const modal = new ModalBuilder().setCustomId('modal_embedcustom_thumbnail').setTitle('Thumbnail da Embed');
        const input = new TextInputBuilder()
          .setCustomId('embedcustom_thumbnail_input')
          .setLabel('Link da thumbnail (deixe vazio para remover)')
          .setStyle(TextInputStyle.Short)
          .setRequired(false);
        if (rascunho.thumbnail) input.setValue(rascunho.thumbnail);
        modal.addComponents(new ActionRowBuilder().addComponents(input));
        return interaction.showModal(modal);
      }

      if (id === 'embedcustom_limpar') {
        rascunhosEmbed.delete(interaction.user.id);
        return interaction.update(montarPainelEmbedCustom(interaction.user.id));
      }

      if (id === 'embedcustom_publicar') {
        const rascunho = obterRascunhoEmbed(interaction.user.id);
        if (!rascunho.titulo && !rascunho.descricao && !rascunho.imagem) {
          return interaction.reply({ content: '⚠️ Configure ao menos um título, descrição ou imagem antes de publicar.', ephemeral: true });
        }

        const embedFinal = new EmbedBuilder().setColor(rascunho.cor || await corPadrao());
        if (rascunho.titulo) embedFinal.setTitle(rascunho.titulo);
        if (rascunho.descricao) embedFinal.setDescription(rascunho.descricao);
        if (rascunho.imagem) embedFinal.setImage(rascunho.imagem);
        if (rascunho.thumbnail) embedFinal.setThumbnail(rascunho.thumbnail);

        await interaction.channel.send({ embeds: [embedFinal] });
        rascunhosEmbed.delete(interaction.user.id);

        return interaction.update({ content: '✅ Embed publicada neste canal!', embeds: [], components: [] });
      }

      if (id.startsWith('entrar_') || id.startsWith('sair_')) {
        // Sem mediador online ninguém entra na fila. O aviso é privado (só quem clicou vê).
        if (id.startsWith('entrar_') && !(await obterProximoMediador())) {
          return interaction.reply({ content: '⚠️ Não temos mediadores online no momento. Aguarde um mediador entrar na fila.', ephemeral: true });
        }

        if (!interaction.deferred && !interaction.replied) await interaction.deferUpdate();

        const messageId = interaction.message.id;
        const userId = interaction.user.id;

        let regra = 'Normal';
        if (id.includes('_ump_')) regra = 'Full UMP e XM8';
        if (id.includes('_gelo_normal_')) regra = 'Gelo Normal';
        if (id.includes('_gelo_infinito_')) regra = 'Gelo Infinito';
        const emu = id.match(/^entrar_emu(\d+)_/);
        if (emu) regra = `${emu[1]} Emu`;

        // Com trava: vários jogadores clicando juntos não sobrescrevem um ao outro
        const filaData = await comTrava(`fila_${messageId}`, async () => {
          const dados = (await db.get(`fila_${messageId}`)) || {
            channelId: interaction.channel.id,
            modalidade: '2X2 MOBILE',
            valor: 0.20,
            jogadores: []
          };

          dados.jogadores = dados.jogadores.filter(j => j.id !== userId);
          if (id.startsWith('entrar_')) dados.jogadores.push({ id: userId, regra });

          await db.set(`fila_${messageId}`, dados);
          return dados;
        });

        const foto = await resolverFoto(interaction.guild);
        const imagem = await db.get('config_imagem');
        const novaEmbed = criarEmbedFila(filaData.modalidade, filaData.valor, filaData.jogadores, foto, imagem);
        await interaction.editReply({ embeds: [novaEmbed] });

        await verificarEMatchmaking(messageId);
        return;
      }

      if (id === 'configfilas_valores') {
        const valoresCentavos = (await db.get('config_valores')) || [20, 50, 100, 200];
        const lista = valoresCentavos.map(v => formatarValorVisual(deCentavos(v))).join('\n• ');

        const rowValores = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId('btn_add_valor').setLabel('➕ Adicionar Valor').setStyle(ButtonStyle.Success),
          new ButtonBuilder().setCustomId('btn_remove_valor').setLabel('➖ Remover Valor').setStyle(ButtonStyle.Danger)
        );

        if (!interaction.deferred && !interaction.replied) await interaction.deferReply({ ephemeral: true });
        return interaction.editReply({
          content: `💰 **Valores Configurados Atualizados:**\n\n• ${lista}`,
          components: [rowValores]
        });
      }

      if (id === 'btn_add_valor') {
        const modal = new ModalBuilder()
          .setCustomId('modal_add_valor')
          .setTitle('Adicionar Valor');

        const input = new TextInputBuilder()
          .setCustomId('valor_input')
          .setLabel('Valor (Ex: 0,20 ou 1,00)')
          .setStyle(TextInputStyle.Short)
          .setPlaceholder('0,20')
          .setRequired(true);

        modal.addComponents(new ActionRowBuilder().addComponents(input));
        return interaction.showModal(modal);
      }

      if (id === 'btn_remove_valor') {
        const valoresCentavos = (await db.get('config_valores')) || [];
        if (valoresCentavos.length === 0) {
          if (!interaction.deferred && !interaction.replied) await interaction.deferReply({ ephemeral: true });
          return interaction.editReply({ content: '⚠️ Não existem valores cadastrados para remover.' });
        }

        const options = valoresCentavos.map(v => ({
          label: `R$ ${formatarValorVisual(deCentavos(v))}`,
          value: String(v)
        }));

        const select = new StringSelectMenuBuilder()
          .setCustomId('select_remover_valor')
          .setPlaceholder('Selecione um valor para remover')
          .addOptions(options);

        if (!interaction.deferred && !interaction.replied) await interaction.deferReply({ ephemeral: true });
        return interaction.editReply({ components: [new ActionRowBuilder().addComponents(select)] });
      }

      if (id === 'configfilas_criar') {
        const menuModalidades = new StringSelectMenuBuilder()
          .setCustomId('select_modalidade_criar')
          .setPlaceholder('Escolha a modalidade desejada')
          .addOptions([
            { label: '1x1 Mobile', value: '1x1 Mobile' },
            { label: '2x2 Mobile', value: '2x2 Mobile' },
            { label: '3x3 Mobile', value: '3x3 Mobile' },
            { label: '4x4 Mobile', value: '4x4 Mobile' },
            { label: '2x2 Misto', value: '2x2 Misto' },
            { label: '3x3 Misto', value: '3x3 Misto' },
            { label: '4x4 Misto', value: '4x4 Misto' },
            { label: '1x1 Emulador', value: '1x1 Emulador' },
            { label: '2x2 Emulador', value: '2x2 Emulador' },
            { label: '3x3 Emulador', value: '3x3 Emulador' },
            { label: '4x4 Emulador', value: '4x4 Emulador' }
          ]);

        if (!interaction.deferred && !interaction.replied) await interaction.deferReply({ ephemeral: true });
        return interaction.editReply({
          content: '❓ **Qual modalidade deseja criar?**',
          components: [new ActionRowBuilder().addComponents(menuModalidades)]
        });
      }

      if (id === 'configfilas_local') {
        if (!interaction.deferred && !interaction.replied) await interaction.deferReply({ ephemeral: true });
        const select = new ChannelSelectMenuBuilder()
          .setCustomId('select_canal_topicos')
          .setPlaceholder('Selecione o canal onde os tópicos serão criados')
          .setChannelTypes(ChannelType.GuildText);
        return interaction.editReply({
          content: '📂 **Em qual canal os tópicos das partidas serão criados?**',
          components: [new ActionRowBuilder().addComponents(select)]
        });
      }

      if (id === 'configfilas_foto') {
        const modal = new ModalBuilder()
          .setCustomId('modal_foto_fila')
          .setTitle('Foto das Filas');

        const input = new TextInputBuilder()
          .setCustomId('foto_input')
          .setLabel('Link da imagem ou org')
          .setStyle(TextInputStyle.Short)
          .setPlaceholder('https://exemplo.com/foto.png ou org')
          .setRequired(true);

        modal.addComponents(new ActionRowBuilder().addComponents(input));
        return interaction.showModal(modal);
      }

      if (id === 'configfilas_imagem') {
        if (!interaction.deferred && !interaction.replied) await interaction.deferReply({ ephemeral: true });
        return interaction.editReply({ content: '🌄 Envie a imagem/link para o Banner principal das filas.' });
      }

      if (id === 'configfilas_excluir') {
        if (!interaction.deferred && !interaction.replied) await interaction.deferReply({ ephemeral: true });

        const row = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId('confirm_excluir_sim1').setLabel('Sim').setStyle(ButtonStyle.Danger),
          new ButtonBuilder().setCustomId('confirm_excluir_nao').setLabel('Não').setStyle(ButtonStyle.Secondary)
        );

        return interaction.editReply({ content: '⚠️ Você realmente quer apagar todas as filas?', components: [row] });
      }

      if (id === 'confirm_excluir_sim1') {
        if (!interaction.deferred && !interaction.replied) await interaction.deferUpdate();

        const row = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId('confirm_excluir_sim2').setLabel('Sim').setStyle(ButtonStyle.Danger),
          new ButtonBuilder().setCustomId('confirm_excluir_nao').setLabel('Não').setStyle(ButtonStyle.Secondary)
        );

        return interaction.editReply({ content: '🚨 **Você tem certeza absoluta? Essa ação não pode ser desfeita.**', components: [row] });
      }

      if (id === 'confirm_excluir_sim2') {
        if (!interaction.deferred && !interaction.replied) await interaction.deferUpdate();
        return interaction.editReply({ content: '🗑️ Todas as filas foram apagadas com sucesso.', components: [] });
      }

      if (id === 'confirm_excluir_nao') {
        if (!interaction.deferred && !interaction.replied) await interaction.deferUpdate();
        return interaction.editReply({ content: '❌ Operação cancelada.', components: [] });
      }

      if (id === 'configbot_taxa') {
        const modal = new ModalBuilder()
          .setCustomId('modal_taxa_org')
          .setTitle('Taxa de Referência da Org');

        const input = new TextInputBuilder()
          .setCustomId('taxa_input')
          .setLabel('Valor da Taxa (Ex: 0,05 ou 0,10)')
          .setStyle(TextInputStyle.Short)
          .setPlaceholder('0,05')
          .setRequired(true);

        modal.addComponents(new ActionRowBuilder().addComponents(input));
        return interaction.showModal(modal);
      }

      if (id === 'configbot_analista') {
        if (!interaction.deferred && !interaction.replied) await interaction.deferReply({ ephemeral: true });
        const select = new RoleSelectMenuBuilder().setCustomId('select_role_analista').setPlaceholder('Selecione os cargos de Analista');
        return interaction.editReply({ components: [new ActionRowBuilder().addComponents(select)] });
      }

      if (id === 'configbot_cargos') {
        if (!interaction.deferred && !interaction.replied) await interaction.deferReply({ ephemeral: true });
        const select = new RoleSelectMenuBuilder().setCustomId('select_role_cargos').setPlaceholder('Selecione os cargos administrativos');
        return interaction.editReply({ components: [new ActionRowBuilder().addComponents(select)] });
      }

      if (id === 'configbot_cor') {
        const modal = new ModalBuilder()
          .setCustomId('modal_cor_hex')
          .setTitle('Cor da Organização');

        const input = new TextInputBuilder()
          .setCustomId('cor_input')
          .setLabel('Código Hexadecimal da Cor')
          .setStyle(TextInputStyle.Short)
          .setPlaceholder('#FF0000')
          .setRequired(true);

        modal.addComponents(new ActionRowBuilder().addComponents(input));
        return interaction.showModal(modal);
      }

      if (id === 'configbot_logs') {
        if (!interaction.deferred && !interaction.replied) await interaction.deferReply({ ephemeral: true });
        const select = new ChannelSelectMenuBuilder().setCustomId('select_channel_logs').setPlaceholder('Selecione o canal de logs');
        return interaction.editReply({ components: [new ActionRowBuilder().addComponents(select)] });
      }

      if (id === 'configbot_mediador') {
        if (!interaction.deferred && !interaction.replied) await interaction.deferReply({ ephemeral: true });
        const select = new RoleSelectMenuBuilder()
          .setCustomId('select_role_mediador')
          .setPlaceholder('Selecione o(s) cargo(s) de Mediador')
          .setMinValues(1)
          .setMaxValues(5);
        return interaction.editReply({
          content: '🎖️ **Quais cargos podem ser mediadores?**',
          components: [new ActionRowBuilder().addComponents(select)]
        });
      }

      if (id === 'configbot_canal_p') {
        if (!interaction.deferred && !interaction.replied) await interaction.deferReply({ ephemeral: true });
        const select = new ChannelSelectMenuBuilder()
          .setCustomId('select_channel_canal_p')
          .setPlaceholder('Selecione o canal exclusivo do .p')
          .setChannelTypes(ChannelType.GuildText);
        return interaction.editReply({
          content: '📇 **Em qual canal só será permitido usar `.p`?** Qualquer outra mensagem enviada nele será apagada automaticamente.',
          components: [new ActionRowBuilder().addComponents(select)]
        });
      }

      // ---------- FILA CONTRA STREAMER (/contra-streamer) ----------

      if (id.startsWith('streamer_jogar_') || id.startsWith('streamer_sair_')) {
        const jogar = id.startsWith('streamer_jogar_');
        const chave = id.replace('streamer_jogar_', '').replace('streamer_sair_', '');
        const userId = interaction.user.id;

        const r = await comTrava(`streamer_${chave}`, async () => {
          const data = await db.get(`streamer_${chave}`);
          if (!data) return { erro: 'Fila não encontrada.' };

          if (jogar) {
            if (!data.aberta) return { erro: '🔒 A fila está fechada no momento.' };
            if (data.jogadores.includes(userId)) return { erro: '⚠️ Você já está na fila.' };
            data.jogadores.push(userId);
          } else {
            if (!data.jogadores.includes(userId)) return { erro: '⚠️ Você não está nesta fila.' };
            data.jogadores = data.jogadores.filter(j => j !== userId);
          }

          await db.set(`streamer_${chave}`, data);
          return { data };
        });

        if (r.erro) return interaction.reply({ content: r.erro, ephemeral: true });
        return interaction.update(await montarFilaStreamer(r.data));
      }

      if (id.startsWith('streamerpainel_')) {
        const partes = id.match(/^streamerpainel_(regras|modo|remover|toggle|puxar)_(\d+)$/);
        if (!partes) return interaction.reply({ content: 'Ação inválida.', ephemeral: true });
        const acao = partes[1];
        const chave = partes[2];

        const data = await db.get(`streamer_${chave}`);
        if (!data) return interaction.reply({ content: 'Fila não encontrada.', ephemeral: true });
        if (!(await podeGerenciarStreamer(interaction, data))) {
          return interaction.reply({ content: '❌ Você não tem permissão para isso.', ephemeral: true });
        }

        if (acao === 'regras') {
          const modal = new ModalBuilder()
            .setCustomId(`modal_streamer_regras_${chave}`)
            .setTitle('Regras da Fila');

          const input = new TextInputBuilder()
            .setCustomId('regras_input')
            .setLabel('Regras da fila')
            .setStyle(TextInputStyle.Paragraph)
            .setPlaceholder('Ex: Full Ump Xm8 sem bug do kit')
            .setMaxLength(500)
            .setRequired(true);

          if (data.regras) input.setValue(data.regras.slice(0, 500));

          modal.addComponents(new ActionRowBuilder().addComponents(input));
          return interaction.showModal(modal);
        }

        if (acao === 'modo') {
          const select = new StringSelectMenuBuilder()
            .setCustomId(`select_streamer_modo_${chave}`)
            .setPlaceholder('Selecione o modo da fila')
            .addOptions([
              { label: '1x1 MOB', value: '1x1 MOB' },
              { label: '2x2 MOB', value: '2x2 MOB' },
              { label: '3x3 MOB', value: '3x3 MOB' },
              { label: '4x4 MOB', value: '4x4 MOB' },
              { label: '1x1 EMU', value: '1x1 EMU' },
              { label: '2x2 EMU', value: '2x2 EMU' },
              { label: '3x3 EMU', value: '3x3 EMU' },
              { label: '4x4 EMU', value: '4x4 EMU' },
              { label: '2x2 MISTO', value: '2x2 MISTO' },
              { label: '3x3 MISTO', value: '3x3 MISTO' },
              { label: '4x4 MISTO', value: '4x4 MISTO' }
            ]);

          return interaction.reply({ content: '🎮 **Selecione o modo da fila:**', components: [new ActionRowBuilder().addComponents(select)], ephemeral: true });
        }

        if (acao === 'remover') {
          const atualizado = await comTrava(`streamer_${chave}`, async () => {
            const dados = await db.get(`streamer_${chave}`);
            if (!dados) return null;
            dados.jogadores = [];
            await db.set(`streamer_${chave}`, dados);
            return dados;
          });

          if (!interaction.deferred && !interaction.replied) await interaction.deferUpdate();
          if (atualizado) await atualizarFilaStreamer(atualizado);
          await interaction.followUp({ content: '✅ Todos os jogadores foram removidos da fila.', ephemeral: true });
          return;
        }

        if (acao === 'puxar') {
          const tamanho = obterTamanhoTimeModo(data.modo || '1x1 MOB');

          if (data.jogadores.length === 0) {
            return interaction.reply({ content: '⚠️ Não há jogadores na fila para puxar.', ephemeral: true });
          }
          if (data.jogadores.length < tamanho) {
            return interaction.reply({ content: `⚠️ É necessário selecionar ${tamanho} jogador(es) (modo atual: ${data.modo || '1x1 MOB'}), mas só há ${data.jogadores.length} na fila.`, ephemeral: true });
          }

          // Mostra apenas quem está na fila deste streamer para escolher quem puxar
          const opcoes = await Promise.all(data.jogadores.slice(0, 25).map(async (uid) => {
            const membro = await interaction.guild.members.fetch(uid).catch(() => null);
            const nome = membro ? membro.displayName : uid;
            return { label: nome.slice(0, 100), value: uid };
          }));

          const select = new StringSelectMenuBuilder()
            .setCustomId(`select_streamer_puxar_${chave}`)
            .setPlaceholder(`Selecione ${tamanho} jogador(es) da fila`)
            .setMinValues(tamanho)
            .setMaxValues(tamanho)
            .addOptions(opcoes);

          return interaction.reply({
            content: `🎯 **Qual(is) jogador(es) deseja puxar?** (modo atual: ${data.modo || '1x1 MOB'})`,
            components: [new ActionRowBuilder().addComponents(select)],
            ephemeral: true
          });
        }

        // acao === 'toggle': ativa ou desativa a fila
        if (!interaction.deferred && !interaction.replied) await interaction.deferUpdate();

        const atualizado = await comTrava(`streamer_${chave}`, async () => {
          const dados = await db.get(`streamer_${chave}`);
          if (!dados) return null;
          dados.aberta = !dados.aberta;
          await db.set(`streamer_${chave}`, dados);
          return dados;
        });

        if (atualizado) await atualizarFilaStreamer(atualizado);
        return;
      }

      // ---------- FILA DE MEDIADORES (/filamed) ----------

      if (id === 'filamed_entrar') {
        const userId = interaction.user.id;

        const checagem = await verificarCargoMediador(interaction.member);
        if (!checagem.ok) {
          const aviso = checagem.motivo === 'nao_configurado'
            ? '⚠️ O cargo de mediador ainda não foi configurado. Peça a um administrador para configurar em /configbot.'
            : '❌ Você não tem o cargo para entrar na fila.';
          return interaction.reply({ content: aviso, ephemeral: true });
        }

        const cadastros = (await db.get('cadastro_mediadores')) || {};
        if (!cadastros[userId] || !cadastros[userId].banco) {
          return interaction.reply({ content: '⚠️ Se cadastre para poder entrar na fila.', ephemeral: true });
        }

        // Quem entra vai direto para o 1º lugar
        const entrou = await comTrava('mediadores', async () => {
          const fila = (await db.get('fila_mediadores_fifo')) || [];
          if (fila.includes(userId)) return false;
          fila.unshift(userId);
          await db.set('fila_mediadores_fifo', fila);
          return true;
        });

        if (!entrou) {
          return interaction.reply({ content: '⚠️ Você já está na fila de mediadores.', ephemeral: true });
        }

        await interaction.update(await montarPainelFilaMed(interaction.guild));
        await atualizarPaineisFilaMed(interaction.message.id);

        // Se já tinha jogadores esperando mediador, monta as partidas agora
        processarFilasPendentes().catch(err => console.error('Erro ao processar filas pendentes:', err));
        return;
      }

      if (id === 'filamed_sair') {
        const userId = interaction.user.id;

        const saiu = await comTrava('mediadores', async () => {
          const fila = (await db.get('fila_mediadores_fifo')) || [];
          if (!fila.includes(userId)) return false;
          await db.set('fila_mediadores_fifo', fila.filter(m => m !== userId));
          return true;
        });

        if (!saiu) {
          return interaction.reply({ content: '⚠️ Você não está na fila de mediadores.', ephemeral: true });
        }

        await interaction.update(await montarPainelFilaMed(interaction.guild));
        await atualizarPaineisFilaMed(interaction.message.id);
        return;
      }

      if (id === 'filamed_rank') {
        const rank = (await db.get('rank_mediadores')) || {};
        const ordenado = Object.entries(rank).sort((a, b) => b[1] - a[1]).slice(0, 10);

        if (ordenado.length === 0) {
          return interaction.reply({ content: '📊 O ranking de mediadores ainda está vazio.', ephemeral: true });
        }

        const linhas = ordenado.map(([uid, qtd], i) => `${i + 1}º - <@${uid}> — ${qtd} partida${qtd === 1 ? '' : 's'}`);
        const embedRank = new EmbedBuilder()
          .setTitle('🏆 Ranking de Mediadores')
          .setDescription(linhas.join('\n'))
          .setColor('#0044FF');

        return interaction.reply({ embeds: [embedRank], ephemeral: true });
      }

      if (id === 'filamed_config') {
        if (!(await ehAdmin(interaction))) {
          return interaction.reply({ content: '❌ Você não tem permissão para usar esta opção.', ephemeral: true });
        }

        const row = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId('filamed_remover').setLabel('Remover Mediador').setStyle(ButtonStyle.Danger),
          new ButtonBuilder().setCustomId('filamed_resetrank').setLabel('Resetar Ranking').setStyle(ButtonStyle.Danger)
        );

        return interaction.reply({ content: 'Selecione uma ação:', components: [row], ephemeral: true });
      }

      if (id === 'filamed_remover') {
        if (!(await ehAdmin(interaction))) {
          return interaction.reply({ content: '❌ Você não tem permissão para usar esta opção.', ephemeral: true });
        }

        if (!interaction.deferred && !interaction.replied) await interaction.deferUpdate();

        const fila = (await db.get('fila_mediadores_fifo')) || [];
        if (fila.length === 0) {
          return interaction.editReply({ content: '⚠️ Não há mediadores na fila no momento.', components: [] });
        }

        const options = await Promise.all(fila.slice(0, 25).map(async (uid, i) => {
          const membro = await interaction.guild.members.fetch(uid).catch(() => null);
          const nome = membro ? membro.displayName : uid;
          return { label: `${i + 1}º - ${nome}`.slice(0, 100), value: uid };
        }));

        const select = new StringSelectMenuBuilder()
          .setCustomId('filamed_remover_select')
          .setPlaceholder('Selecione o mediador para remover')
          .addOptions(options);

        return interaction.editReply({
          content: 'Selecione o mediador que será removido da fila:',
          components: [new ActionRowBuilder().addComponents(select)]
        });
      }

      if (id === 'filamed_resetrank') {
        if (!(await ehAdmin(interaction))) {
          return interaction.reply({ content: '❌ Você não tem permissão para usar esta opção.', ephemeral: true });
        }

        await db.set('rank_mediadores', {});
        return interaction.update({ content: '✅ Ranking de mediadores resetado.', components: [] });
      }

      // ---------- CADASTRO DE MEDIADORES (/cadastromed) ----------

      if (id === 'cadastromed_cadastrar') {
        const checagem = await verificarCargoMediador(interaction.member);
        if (!checagem.ok) {
          const aviso = checagem.motivo === 'nao_configurado'
            ? '⚠️ O cargo de mediador ainda não foi configurado. Peça a um administrador para configurar em /configbot.'
            : '❌ Você não tem o cargo de mediador para se cadastrar.';
          return interaction.reply({ content: aviso, ephemeral: true });
        }

        const modal = new ModalBuilder()
          .setCustomId('modal_cadastro_pix')
          .setTitle('Cadastrar Chave PIX');

        const inputTitular = new TextInputBuilder()
          .setCustomId('pix_titular')
          .setLabel('Nome do titular da conta')
          .setStyle(TextInputStyle.Short)
          .setPlaceholder('Nome completo')
          .setMaxLength(100)
          .setRequired(true);

        const inputBanco = new TextInputBuilder()
          .setCustomId('pix_banco')
          .setLabel('Nome do banco')
          .setStyle(TextInputStyle.Short)
          .setPlaceholder('Ex: Nubank, Inter, Banco do Brasil')
          .setMaxLength(100)
          .setRequired(true);

        const inputChave = new TextInputBuilder()
          .setCustomId('pix_chave')
          .setLabel('Chave PIX')
          .setStyle(TextInputStyle.Short)
          .setPlaceholder('CPF, e-mail, telefone ou chave aleatória')
          .setMaxLength(100)
          .setRequired(true);

        modal.addComponents(
          new ActionRowBuilder().addComponents(inputTitular),
          new ActionRowBuilder().addComponents(inputBanco),
          new ActionRowBuilder().addComponents(inputChave)
        );
        return interaction.showModal(modal);
      }

      if (id === 'cadastromed_verificar') {
        const cadastros = (await db.get('cadastro_mediadores')) || {};
        const cadastro = cadastros[interaction.user.id];

        if (!cadastro) {
          return interaction.reply({ content: '⚠️ Você ainda não cadastrou uma chave PIX.', ephemeral: true });
        }

        return interaction.reply({
          content: `💠 **Sua chave PIX cadastrada:**\n\n**Titular:** ${cadastro.titular}\n**Banco:** ${cadastro.banco || 'não informado (cadastre novamente)'}\n**Chave:** \`${cadastro.chave}\``,
          ephemeral: true
        });
      }

      if (id === 'cadastromed_verificar_adm') {
        if (!(await ehAdmin(interaction))) {
          return interaction.reply({ content: '❌ Apenas administradores podem usar este botão.', ephemeral: true });
        }

        const cadastros = (await db.get('cadastro_mediadores')) || {};
        const entradas = Object.entries(cadastros);

        if (entradas.length === 0) {
          return interaction.reply({ content: '⚠️ Nenhum mediador cadastrado ainda.', ephemeral: true });
        }

        let texto = entradas.map(([uid, c]) => `<@${uid}> — **${c.titular}** — ${c.banco || 'sem banco'} — \`${c.chave}\``).join('\n');
        if (texto.length > 3900) {
          texto = texto.slice(0, 3900);
          texto = texto.slice(0, texto.lastIndexOf('\n')) + '\n…';
        }

        const embedAdm = new EmbedBuilder()
          .setTitle('🛡️ Mediadores Cadastrados')
          .setDescription(texto)
          .setColor('#0044FF');

        return interaction.reply({ embeds: [embedAdm], ephemeral: true });
      }

      // ---------- PAINEL DE PERFIL E RANKING (/ranking) ----------

      if (id === 'ranking_perfil') {
        const perfis = (await db.get('perfis_jogadores')) || {};
        return interaction.reply({ embeds: [montarEmbedPerfil(interaction.user, perfis[interaction.user.id])], ephemeral: true });
      }

      if (id.startsWith('ranking_ranking_')) {
        const categoria = id.replace('ranking_ranking_', '');
        if (!RANKING_CATEGORIAS.includes(categoria)) {
          return interaction.reply({ content: 'Categoria de ranking inválida.', ephemeral: true });
        }

        const painel = await montarEmbedRanking(categoria, interaction.guild);

        // Se a mensagem clicada é o painel público (com "Ver perfil"/"Ver ranking"), essa é a
        // primeira abertura: responde em uma nova mensagem efêmera. Se já é uma mensagem de
        // ranking (troca de categoria pelas setas), apenas atualiza a mesma mensagem efêmera.
        const ehPainelPublico = interaction.message.components?.[0]?.components?.some(c => c.customId === 'ranking_perfil');

        if (ehPainelPublico) {
          return interaction.reply({ ...painel, ephemeral: true });
        }

        if (!interaction.deferred && !interaction.replied) await interaction.deferUpdate();
        return interaction.editReply(painel);
      }

      if (id.startsWith('liberar_chave_')) {
        const threadId = id.replace('liberar_chave_', '');
        const matchKey = `match_${threadId}`;
        const matchData = await db.get(matchKey);

        if (!matchData) {
          return interaction.reply({ content: 'Partida não encontrada.', ephemeral: true });
        }

        if (interaction.user.id !== matchData.mediadorId) {
          return interaction.reply({ content: '❌ Você não tem permissão para isso.', ephemeral: true });
        }

        const cadastros = (await db.get('cadastro_mediadores')) || {};
        const pix = cadastros[matchData.mediadorId];
        if (!pix) {
          return interaction.reply({ content: '⚠️ Você não tem chave PIX cadastrada. Cadastre pelo painel do /cadastromed.', ephemeral: true });
        }

        const valorPagar = matchData.valorPagar || await calcularValorComTaxaVirtual(matchData.valor);
        const valorNumerico = parseFloat(String(valorPagar).replace(',', '.')) || matchData.valor;
        const qrBuffer = await gerarQrCodePixBuffer(pix, valorNumerico);

        // Edita a própria mensagem clicada (não envia uma nova) e anexa o QR Code do Pix nela.
        const conteudo = `**Valor a pagar: R$ ${valorPagar}**\n\n**Nome:** ${pix.titular}\n**Chave:** \`${pix.chave}\`\n**Qrcode:**`;
        const opcoesUpdate = { content: conteudo, embeds: [], components: [] };
        if (qrBuffer) opcoesUpdate.files = [new AttachmentBuilder(qrBuffer, { name: 'qrcode-pix.png' })];

        return interaction.update(opcoesUpdate);
      }

      if (id.startsWith('partida_confirmar_')) {
        const threadId = id.replace('partida_confirmar_', '');
        const matchKey = `match_${threadId}`;
        const userId = interaction.user.id;

        // Com trava: se os 2 jogadores clicarem juntos, nenhuma confirmação se perde
        const conf = await comTrava(matchKey, async () => {
          const dados = await db.get(matchKey);
          if (!dados) return { erro: 'Partida não encontrada.' };
          if (userId !== dados.p1 && userId !== dados.p2) return { erro: 'Você não participa desta partida.' };
          if (dados.confirmations.length >= 2) return { erro: '⚠️ Esta aposta já foi confirmada pelos dois jogadores.' };
          if (dados.confirmations.includes(userId)) return { erro: 'Você já confirmou esta partida.' };

          dados.confirmations.push(userId);
          await db.set(matchKey, dados);
          return { dados };
        });

        if (conf.erro) {
          return interaction.reply({ content: conf.erro, ephemeral: true });
        }
        const matchData = conf.dados;

        if (!interaction.deferred && !interaction.replied) await interaction.deferUpdate();

        if (matchData.confirmations.length === 1) {
          const embedConf1 = new EmbedBuilder()
            .setTitle('✅ Aposta Confirmada')
            .setDescription(`<@${userId}> confirmou aposta.\n\n↪ O outro jogador precisa confirmar para prosseguir.`)
            .setColor('#00FF00');

          await interaction.channel.send({ embeds: [embedConf1] });
        }

        if (matchData.confirmations.length === 2) {
          // Trava os botões Confirmar/Cancelar da mensagem da aposta
          await interaction.editReply({ components: [await montarBotoesPartida(threadId, true)] }).catch(() => {});

          const rank = (await db.get('rank_mediadores')) || {};
          rank[matchData.mediadorId] = (rank[matchData.mediadorId] || 0) + 1;
          await db.set('rank_mediadores', rank);

          const embedConf2 = new EmbedBuilder()
            .setTitle('✅ Aposta Confirmada')
            .setDescription(`<@${userId}> confirmou aposta.\n\n↪ a partida pode prosseguir.`)
            .setColor('#00FF00');

          await interaction.channel.send({ embeds: [embedConf2] });

          // Renomeia o tópico para "fila (REGRA ESCOLHIDA)"
          if (interaction.channel.setName) {
            const nomeRegra = matchData.regra ? `fila (${matchData.regra})` : `fila (${matchData.modalidade})`;
            await interaction.channel.setName(nomeRegra.slice(0, 100)).catch(() => {});
          }

          // Posta o painel do mediador (Menu ADM + barra .med) direto no tópico
          await interaction.channel.send(await montarPainelMediador(matchData, threadId));

          const valorPagar = matchData.valorPagar || await calcularValorComTaxaVirtual(matchData.valor);
          const rowLiberar = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId(`liberar_chave_${threadId}`).setLabel('Liberar Chave').setStyle(ButtonStyle.Secondary).setEmoji(await obterEmoji('liberar_chave', '💠'))
          );

          await interaction.channel.send({
            content: `**Valor a pagar: R$ ${valorPagar}**\n\nAguarde o mediador <@${matchData.mediadorId}> liberar a chave.`,
            components: [rowLiberar]
          });
        }
        return;
      }

      if (id.startsWith('partida_cancelar_')) {
        const threadId = id.replace('partida_cancelar_', '');
        const matchKey = `match_${threadId}`;
        const matchData = await db.get(matchKey);

        if (!matchData) {
          return interaction.reply({ content: 'Partida não encontrada.', ephemeral: true });
        }

        const userId = interaction.user.id;

        if (userId !== matchData.p1 && userId !== matchData.p2) {
          return interaction.reply({ content: 'Você não participa desta partida.', ephemeral: true });
        }

        if (matchData.confirmations.length >= 2) {
          return interaction.reply({ content: '❌ Não é mais possível cancelar: os dois jogadores já confirmaram.', ephemeral: true });
        }

        await db.delete(matchKey);

        if (!interaction.deferred && !interaction.replied) await interaction.deferUpdate();
        await interaction.channel.send({ content: `❌ Partida cancelada por <@${userId}>.` });

        setTimeout(async () => {
          await interaction.channel.delete().catch(() => {});
        }, 3000);
        return;
      }
    }

    if (interaction.isRoleSelectMenu() || interaction.isChannelSelectMenu()) {
      if (!interaction.deferred && !interaction.replied) await interaction.deferUpdate();

      let chaveConfig = `config_${interaction.customId}`;
      let valorConfig = interaction.values;
      let textoResposta = '✅ Configuração salva no banco de dados com sucesso!';

      if (interaction.customId === 'select_role_mediador') {
        chaveConfig = 'config_cargo_mediador';
      } else if (interaction.customId === 'select_canal_topicos') {
        chaveConfig = 'config_canal_topicos';
        valorConfig = interaction.values[0];
        textoResposta = `✅ Os tópicos das partidas serão criados em <#${valorConfig}>.`;
      } else if (interaction.customId === 'select_ticket_setores') {
        chaveConfig = 'config_ticket_setores';
        textoResposta = `✅ Setores de ticket salvos: ${interaction.values.map(v => `<#${v}>`).join(', ')}`;
      } else if (interaction.customId === 'select_ticket_staff_cargos') {
        chaveConfig = 'config_ticket_staff_cargos';
        textoResposta = `✅ Cargos da equipe de tickets salvos: ${interaction.values.map(v => `<@&${v}>`).join(', ')}`;
      } else if (interaction.customId === 'select_channel_canal_p') {
        chaveConfig = 'config_canal_p';
        valorConfig = interaction.values[0];
        textoResposta = `✅ Agora só será permitido usar \`.p\` em <#${valorConfig}>. Qualquer outra mensagem enviada lá será apagada.`;
      }

      await db.set(chaveConfig, valorConfig);
      return interaction.followUp({ content: textoResposta, ephemeral: true });
    }

  } catch (error) {
    console.error('Erro no handler de interações:', error);
    try {
      const aviso = { content: 'Ocorreu um erro interno ao processar a ação.', ephemeral: true };
      if (interaction.replied || interaction.deferred) {
        await interaction.followUp(aviso);
      } else {
        await interaction.reply(aviso);
      }
    } catch (e) {}
  }
});

// ==========================================
// COMANDOS POR MENSAGEM: .p (perfil), .med (painel do mediador) e .d (personalização)
// ==========================================

client.on(Events.MessageCreate, async (message) => {
  try {
    if (message.author.bot || !message.guild) return;

    // Canal exclusivo do .p (configurado em /configbot > Canal .p): só pode ter ".p" ou
    // ".p @alguém" nele. Qualquer outra mensagem é apagada sempre.
    const canalP = await db.get('config_canal_p');
    if (canalP && message.channel.id === canalP) {
      const conteudo = message.content.trim();
      const ehComandoPValido = /^\.p(\s+<@!?\d+>)?$/i.test(conteudo);
      if (!ehComandoPValido) {
        await message.delete().catch(() => {});
        return;
      }
    }

    const [comando] = message.content.trim().split(/\s+/);
    const cmd = (comando || '').toLowerCase();
    const semPingar = { repliedUser: false };

    if (cmd === '.p') {
      const alvo = message.mentions.users.first() || message.author;
      const perfis = (await db.get('perfis_jogadores')) || {};
      await message.reply({ embeds: [montarEmbedPerfil(alvo, perfis[alvo.id])], allowedMentions: semPingar });
      return;
    }

    if (cmd === '.med') {
      const matchData = await db.get(`match_${message.channel.id}`);
      if (!matchData) {
        await message.reply({ content: '❌ Este comando só pode ser usado dentro do tópico de uma aposta.', allowedMentions: semPingar });
        return;
      }
      if (message.author.id !== matchData.mediadorId) {
        await message.reply({ content: '❌ Você não tem permissão para isso.', allowedMentions: semPingar });
        return;
      }
      await message.channel.send(await montarPainelMediador(matchData, message.channel.id));
      return;
    }

    if (cmd === '.d') {
      if (!(await ehAdminMensagem(message))) {
        await message.reply({ content: '❌ Você não tem permissão para usar esse comando.', allowedMentions: semPingar });
        return;
      }
      await message.channel.send(montarPainelPersonalizacao());
      return;
    }

    // O mediador só cria a embed da sala com o comando explícito ".sala ID SENHA" — assim uma
    // mensagem qualquer de duas palavras (ex: só bater papo no tópico) nunca dispara a sala à toa.
    if (cmd === '.sala') {
      const matchData = await db.get(`match_${message.channel.id}`);
      if (!matchData) {
        await message.reply({ content: '❌ Este comando só pode ser usado dentro do tópico de uma aposta.', allowedMentions: semPingar });
        return;
      }
      if (message.author.id !== matchData.mediadorId) {
        await message.reply({ content: '❌ Você não tem permissão para isso.', allowedMentions: semPingar });
        return;
      }

      const partes = message.content.trim().split(/\s+/).filter(Boolean);
      const salaId = partes[1];
      const salaSenha = partes[2];

      if (partes.length !== 3 || !salaId || !salaSenha) {
        await message.reply({ content: '❌ Use: `.sala ID SENHA` (Ex: `.sala Full roxa`)', allowedMentions: semPingar });
        return;
      }

      await comTrava(`match_${message.channel.id}`, async () => {
        const atual = await db.get(`match_${message.channel.id}`);
        if (!atual) return;
        atual.salaId = salaId;
        atual.salaSenha = salaSenha;
        await db.set(`match_${message.channel.id}`, atual);
      });

      const valorVencedorReais = (typeof matchData.valor === 'number' ? matchData.valor : parseFloat(matchData.valor) || 0) * 2;
      const valorFormatado = formatarValorVisual(valorVencedorReais);

      const embedSala = new EmbedBuilder()
        .setDescription(
          `**A sala foi criada!**\nEntre *3 a 5 minutos* a partida será iniciada!\n\n` +
          `↪ __Formato:__ \`${matchData.modalidade}${matchData.regra ? ' ' + matchData.regra : ''}\`\n\n` +
          `↪ __ID:__ \`${salaId}\`\n\n` +
          `↪ __Senha:__ \`${salaSenha}\`\n\n` +
          `↪ __Valor para o vencedor:__ **R$${valorFormatado}**`
        )
        .setColor('#2B2D31');

      const rowSala = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`sala_copiar_id_${message.channel.id}`).setLabel('Copiar ID').setStyle(ButtonStyle.Secondary).setEmoji(await obterEmoji('sala_copiar_id', '🆔')),
        new ButtonBuilder().setCustomId(`sala_alterar_valor_${message.channel.id}`).setLabel('Alterar Valor').setStyle(ButtonStyle.Secondary).setEmoji(await obterEmoji('sala_alterar_valor', '✏️'))
      );

      await message.channel.send({
        content: `<@${matchData.p1}> <@${matchData.p2}>`,
        embeds: [embedSala],
        components: [rowSala]
      });

      if (message.channel.setName) {
        await message.channel.setName(`pagar-${valorFormatado}`.slice(0, 100)).catch(() => {});
      }
      return;
    }
  } catch (error) {
    console.error('Erro no handler de mensagens:', error);
  }
});

// ==========================================
// TRATAMENTO DE ERROS GLOBAIS (evita o processo cair)
// ==========================================

client.on(Events.Error, (err) => console.error('Erro no client:', err));
process.on('unhandledRejection', (err) => console.error('Rejeição não tratada:', err));
process.on('uncaughtException', (err) => console.error('Exceção não capturada:', err));

// ==========================================
// INICIALIZAÇÃO E SLASH COMMANDS
// ==========================================

client.once(Events.ClientReady, async () => {
  console.log(`Bot conectado como ${client.user.tag}`);

  const commands = [
    new SlashCommandBuilder()
      .setName('configfilas')
      .setDescription('Painel de configuração das filas')
      .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
    new SlashCommandBuilder()
      .setName('configbot')
      .setDescription('Painel de configuração geral do bot')
      .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
    new SlashCommandBuilder()
      .setName('filamed')
      .setDescription('Cria o painel da fila de mediadores')
      .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
    new SlashCommandBuilder()
      .setName('cadastromed')
      .setDescription('Cria o painel de cadastro de chave PIX dos mediadores')
      .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
    new SlashCommandBuilder()
      .setName('contra-streamer')
      .setDescription('Cria a fila contra um streamer')
      .addUserOption(option => option
        .setName('streamer')
        .setDescription('Selecione o streamer')
        .setRequired(true))
      .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
    new SlashCommandBuilder()
      .setName('ranking')
      .setDescription('Painel de perfil e ranking do servidor'),
    new SlashCommandBuilder()
      .setName('rank')
      .setDescription('Define o canal do ranking diário automático (Top 10 de vitórias, todo dia às 00:00 de Brasília)')
      .addChannelOption(option => option
        .setName('canal')
        .setDescription('Canal onde o ranking diário será enviado')
        .addChannelTypes(ChannelType.GuildText)
        .setRequired(true))
      .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
    new SlashCommandBuilder()
      .setName('configticket')
      .setDescription('Painel de configuração do sistema de tickets')
      .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
    new SlashCommandBuilder()
      .setName('embed')
      .setDescription('Abre o construtor de embed personalizada (título, descrição, cor e imagens)')
      .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
  ];

  const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);

  try {
    await rest.put(Routes.applicationCommands(client.user.id), { body: commands });
    console.log('Comandos Slash registrados com sucesso.');
  } catch (err) {
    console.error('Erro ao registrar comandos Slash:', err);
  }

  // Ranking diário automático: checa a cada 30s se já é 00:00 no horário de Brasília
  verificarRankingDiario();
  setInterval(verificarRankingDiario, 30 * 1000);
});

if (!process.env.DISCORD_TOKEN) {
  console.error('❌ Variável de ambiente DISCORD_TOKEN não definida no Render (Environment).');
  process.exit(1);
}

(async () => {
  try {
    await conectarMongo();
  } catch (err) {
    console.error('❌ Falha ao conectar no MongoDB. Verifique a variável MONGODB_URI.', err);
    process.exit(1);
  }

  client.login(process.env.DISCORD_TOKEN).catch((err) => {
    console.error('❌ Falha ao conectar no Discord:', err.message);
    if (String(err.message).toLowerCase().includes('disallowed intents')) {
      console.error('👉 Ative "Message Content Intent" e "Server Members Intent" em Discord Developer Portal > seu app > Bot > Privileged Gateway Intents.');
    }
    process.exit(1);
  });
})();
