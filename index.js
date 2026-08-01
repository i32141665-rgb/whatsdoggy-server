import express from 'express';
import http from 'http';
import { Server } from 'socket.io';
import makeWASocket, { useMultiFileAuthState, DisconnectReason } from '@whiskeysockets/baileys';
import { MongoClient } from 'mongodb';
import qrcode from 'qrcode';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));
app.use(express.static(__dirname));

let sock;
let qrCodeData = null;
let isConnected = false;

async function startWhatsApp() {
    const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');

    sock = makeWASocket({
        auth: state,
        printQRInTerminal: false
    });

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;
        if (qr) {
            qrCodeData = await qrcode.toDataURL(qr);
            io.emit('qr_code', qrCodeData);
        }
        if (connection === 'open') {
            isConnected = true;
            io.emit('connection_status', { connected: true });
        } else if (connection === 'close') {
            isConnected = false;
            io.emit('connection_status', { connected: false });
            if (lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut) {
                startWhatsApp();
            }
        }
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        if (type !== 'notify') return;
        for (const msg of messages) {
            if (!msg.message || msg.key.fromMe) continue;
            const remoteJid = msg.key.remoteJid;
            let messageText = '';
            let messageType = 'text';

            if (msg.message.conversation) {
                messageText = msg.message.conversation;
            } else if (msg.message.imageMessage) {
                messageText = '[Фотография]';
                messageType = 'image';
            } else if (msg.message.audioMessage) {
                messageText = '[Голосовое сообщение]';
                messageType = 'audio';
            }

            io.emit('new_message', { from: remoteJid, text: messageText, type: messageType, fromMe: false });
        }
    });
}

io.on('connection', (socket) => {
    socket.on('check_status', () => {
        if (isConnected) socket.emit('connection_status', { connected: true });
        else if (qrCodeData) socket.emit('qr_code', qrCodeData);
        else socket.emit('connection_status', { connected: false });
    });
});

app.post('/api/send', async (req, res) => {
    const { number, message, media, type } = req.body;
    try {
        let jid = number.includes('@') ? number : number + '@s.whatsapp.net';
        if (number.includes('-')) jid = number + '@g.us';

        if (media) {
            const base64Data = media.split(',')[1];
            const buffer = Buffer.from(base64Data, 'base64');

            if (type === 'image') {
                await sock.sendMessage(jid, { image: buffer, caption: message || '' });
            } else if (type === 'audio') {
                // Отправляем как документ аудиопотока, чтобы WhatsApp гарантированно принял файл без ошибок кодека
                await sock.sendMessage(jid, { 
                    audio: buffer, 
                    mimetype: 'audio/mp4',
                    ptt: false 
                });
            }
        } else {
            await sock.sendMessage(jid, { text: message });
        }
        res.status(200).json({ success: true });
    } catch (err) {
        console.error('Ошибка отправки:', err);
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/logout', async (req, res) => {
    try {
        await sock.logout();
        isConnected = false;
        res.status(200).json({ success: true });
        startWhatsApp();
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

startWhatsApp();
server.listen(process.env.PORT || 3000);
