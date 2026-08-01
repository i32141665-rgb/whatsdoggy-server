import makeWASocket, { useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } from '@whiskeysockets/baileys';
import express from 'express';
import http from 'http';
import { Server } from 'socket.io';
import cors from 'cors';
import fs from 'fs';
import path from 'path';

const app = express();
app.use(cors());
app.use(express.json());

const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: "*" }
});

const PORT = process.env.PORT || 3000;

const __dirname = path.resolve();
app.use(express.static(path.join(__dirname)));

let sock = null;
let qrCodeData = null;
let connectionStatus = 'disconnected';

async function startWhatsApp() {
    // Автоматически очищаем старую сессию при старте, чтобы не зависать
    try {
        if (fs.existsSync('auth_info_baileys')) {
            fs.rmSync('auth_info_baileys', { recursive: true, force: true });
            console.log('Старая сессия очищена');
        }
    } catch (e) {
        console.error('Ошибка при очистке сессии:', e);
    }

    const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');
    const { version } = await fetchLatestBaileysVersion();

    sock = makeWASocket({
        version,
        auth: state,
        printQRInTerminal: true
    });

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;
        
        if (qr) {
            qrCodeData = qr;
            connectionStatus = 'qr';
            io.emit('qr_code', qr); // Передаем на клиент через событие qr_code
        }

        if (connection === 'close') {
            const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
            connectionStatus = 'disconnected';
            qrCodeData = null;
            io.emit('connection_status', { connected: false });
            if (shouldReconnect) {
                startWhatsApp();
            }
        } else if (connection === 'open') {
            connectionStatus = 'connected';
            qrCodeData = null;
            io.emit('connection_status', { connected: true });
            console.log('WhatsApp успешно подключен!');
        }
    });

    sock.ev.on('creds.update', saveCreds);

    // Получение входящих сообщений
    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        if (type !== 'notify') return;
        for (const msg of messages) {
            if (!msg.message) continue;
            
            let text = '';
            let msgType = 'text';

            if (msg.message.conversation) {
                text = msg.message.conversation;
            } else if (msg.message.extendedTextMessage) {
                text = msg.message.extendedTextMessage.text;
            } else if (msg.message.imageMessage) {
                text = msg.message.imageMessage.caption || '';
                msgType = 'image';
            } else if (msg.message.audioMessage) {
                msgType = 'audio';
            }

            const fromMe = msg.key.fromMe;
            const remoteJid = msg.key.remoteJid;

            io.emit('new_message', {
                from: remoteJid,
                text: text,
                fromMe: fromMe,
                type: msgType
            });
        }
    });
}

// Связь с клиентской частью через Socket.IO
io.on('connection', (socket) => {
    socket.on('check_status', () => {
        if (connectionStatus === 'connected') {
            socket.emit('connection_status', { connected: true });
        } else if (qrCodeData) {
            socket.emit('qr_code', qrCodeData);
        } else {
            socket.emit('connection_status', { connected: false });
        }
    });

    // Отправка сообщений и медиа из веб-интерфейса
    socket.on('api/send', async (data) => {
        // Поддерживаем оба варианта вызова (прямой fetch от клиента обрабатывается в express-роутах ниже)
    });
});

// Express API для отправки сообщений и выхода
app.post('/api/send', async (req, res) => {
    try {
        if (!sock) return res.status(500).json({ error: 'WhatsApp не запущен' });
        const { number, message, media, type } = req.body;
        const jid = number.includes('@s.whatsapp.net') ? number : number + '@s.whatsapp.net';

        if (media) {
            const base64Data = media.replace(/^data:.*;base64,/, "");
            const buffer = Buffer.from(base64Data, 'base64');

            if (type === 'image') {
                await sock.sendMessage(jid, { image: buffer, caption: message || '' });
            } else if (type === 'audio') {
                await sock.sendMessage(jid, {
                    audio: buffer,
                    mimetype: 'audio/ogg; codecs=opus',
                    ptt: true // Голосовое сообщение с волной
                });
            }
        } else {
            await sock.sendMessage(jid, { text: message });
        }

        res.json({ success: true });
    } catch (e) {
        console.error('Ошибка отправки:', e);
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/logout', async (req, res) => {
    try {
        if (sock) {
            await sock.logout();
        }
        if (fs.existsSync('auth_info_baileys')) {
            fs.rmSync('auth_info_baileys', { recursive: true, force: true });
        }
        res.json({ success: true });
        setTimeout(() => process.exit(0), 1000); // Перезапуск процесса для нового QR
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

server.listen(PORT, () => {
    console.log(`Сервер запущен на порту ${PORT}`);
    startWhatsApp();
});
