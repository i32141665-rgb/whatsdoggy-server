const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const pino = require('pino');
const qrcode = require('qrcode');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));
app.use(express.static('public')); // Убедись, что index.html лежит в папке public или рядом со скриптом

let sock = null;
let qrCodeData = null;
let isConnected = false;

async function startWhatsApp() {
    const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');
    const { version } = await fetchLatestBaileysVersion();

    sock = makeWASocket({
        version,
        auth: state,
        logger: pino({ level: 'silent' }),
        printQRInTerminal: true
    });

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            qrCodeData = await qrcode.toDataURL(qr);
            isConnected = false;
            io.emit('qr_code', qrCodeData);
        }

        if (connection === 'open') {
            isConnected = true;
            qrCodeData = null;
            console.log('WhatsApp успешно подключен!');
            io.emit('connection_status', { connected: true });
        } else if (connection === 'close') {
            isConnected = false;
            const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
            console.log('Соединение закрыто. Переподключение:', shouldReconnect);
            io.emit('connection_status', { connected: false });
            if (shouldReconnect) {
                startWhatsApp();
            }
        }
    });

    sock.ev.on('creds.update', saveCreds);

    // Обработка входящих сообщений
    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        if (type !== 'notify') return;

        for (const msg of messages) {
            if (!msg.message) continue;

            const remoteJid = msg.key.remoteJid;
            const fromMe = msg.key.fromMe;
            
            let messageText = '';
            let msgType = 'text';

            if (msg.message.conversation) {
                messageText = msg.message.conversation;
            } else if (msg.message.extendedTextMessage) {
                messageText = msg.message.extendedTextMessage.text;
            } else if (msg.message.imageMessage) {
                messageText = msg.message.imageMessage.caption || 'Фото';
                msgType = 'image';
            } else if (msg.message.audioMessage) {
                messageText = 'Голосовое сообщение';
                msgType = 'audio';
            }

            io.emit('new_message', {
                from: remoteJid,
                text: messageText,
                fromMe: fromMe,
                type: msgType
            });
        }
    });
}

// API для отправки сообщений, картинок и голосовых
app.post('/api/send', async (req, res) => {
    try {
        if (!isConnected || !sock) {
            return res.status(400).json({ error: 'WhatsApp не подключен' });
        }

        const { number, message, media, type } = req.body;
        const jid = number.includes('@') ? number : `${number}@s.whatsapp.net`;

        if (type === 'image' && media) {
            const buffer = Buffer.from(media.split(',')[1], 'base64');
            await sock.sendMessage(jid, { image: buffer, caption: message || '' });
        } else if (type === 'audio' && media) {
            const buffer = Buffer.from(media.split(',')[1], 'base64');
            
            // ПРЕВРАЩАЕМ В ПОЛНОЦЕННОЕ ГОЛОСОВОЕ СООБЩЕНИЕ С КНОПКОЙ PLAY И ВОЛНОЙ
            await sock.sendMessage(jid, {
                audio: buffer,
                mimetype: 'audio/ogg; codecs=opus',
                ptt: true 
            });
        } else if (message) {
            await sock.sendMessage(jid, { text: message });
        }

        res.json({ success: true });
    } catch (error) {
        console.error('Ошибка отправки:', error);
        res.status(500).json({ error: error.message });
    }
});

// API для проверки статуса подключения
app.get('/api/status', (req, res) => {
    res.json({ connected: isConnected, qr: qrCodeData });
});

// API для выхода из сессии
app.post('/api/logout', async (req, res) => {
    try {
        if (sock) {
            await sock.logout();
        }
        isConnected = false;
        res.json({ success: true });
        setTimeout(() => startWhatsApp(), 1000);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

io.on('connection', (socket) => {
    socket.on('check_status', () => {
        if (isConnected) {
            socket.emit('connection_status', { connected: true });
        } else if (qrCodeData) {
            socket.emit('qr_code', qrCodeData);
        } else {
            socket.emit('connection_status', { connected: false });
        }
    });
});

server.listen(3000, () => {
    console.log('Сервер запущен на http://localhost:3000');
    startWhatsApp();
});
