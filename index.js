import makeWASocket, { useMultiFileAuthState, DisconnectReason } from '@whiskeysockets/baileys';
import express from 'express';
import http from 'http';
import { Server } from 'socket.io';
import qrcode from 'qrcode';
import pino from 'pino';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(__dirname));

let sock;
let currentQr = null;

async function connectToWhatsApp() {
    const { state, saveCreds } = await useMultiFileAuthState('auth_info');

    sock = makeWASocket({
        auth: state,
        logger: pino({ level: 'silent' }),
        printQRInTerminal: false
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            try {
                currentQr = await qrcode.toDataURL(qr);
                io.emit('qr', { qr: currentQr });
            } catch (err) {
                console.error('Ошибка генерации QR:', err);
            }
        }

        if (connection === 'open') {
            console.log('WhatsDoggy успешно подключен к WhatsApp!');
            currentQr = null;
            io.emit('ready');
        }

        if (connection === 'close') {
            const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
            if (shouldReconnect) {
                connectToWhatsApp();
            }
        }
    });

    sock.ev.on('messages.upsert', async (m) => {
        const msg = m.messages[0];
        if (!msg.key.fromMe && m.type === 'notify') {
            const remoteJid = msg.key.remoteJid;
            
            // Игнорируем @lid системные чаты
            if (remoteJid.includes('@lid')) return;

            const senderPhone = remoteJid.replace('@s.whatsapp.net', '');
            let messageText = '';
            let messageType = 'text';

            if (msg.message?.conversation) {
                messageText = msg.message.conversation;
            } else if (msg.message?.extendedTextMessage) {
                messageText = msg.message.extendedTextMessage.text;
            }

            io.emit('message', {
                from: senderPhone,
                text: messageText,
                type: messageType
            });
        }
    });
}

io.on('connection', (socket) => {
    if (currentQr) {
        socket.emit('qr', { qr: currentQr });
    } else if (sock && sock.user) {
        socket.emit('ready');
    }

    // Возвращаем пустой список контактов без тестовых друзей
    socket.on('get_contacts', async () => {
        socket.emit('contacts', []);
    });

    socket.on('send_message', async (data) => {
        try {
            // Формируем правильный JID с суффиксом, чтобы сообщение точно доходило
            let cleanTo = data.to.replace('@s.whatsapp.net', '').trim();
            const jid = `${cleanTo}@s.whatsapp.net`;

            if (data.type === 'image') {
                const buffer = Buffer.from(data.text.split(',')[1], 'base64');
                await sock.sendMessage(jid, { image: buffer });
            } else if (data.type === 'audio') {
                const buffer = Buffer.from(data.text.split(',')[1], 'base64');
                await sock.sendMessage(jid, { audio: buffer, mimetype: 'audio/mp4', ptt: true });
            } else {
                await sock.sendMessage(jid, { text: data.text });
            }
        } catch (error) {
            console.error('Ошибка отправки сообщения:', error);
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Сервер запущен на порту ${PORT}`);
    connectToWhatsApp();
});
