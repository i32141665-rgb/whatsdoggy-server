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

// Раздаем статические файлы
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
            console.log('Соединение закрыто. Переподключение:', shouldReconnect);
            if (shouldReconnect) {
                connectToWhatsApp();
            } else {
                console.log('Сессия завершена (Logged out). Удалите папку auth_info для нового входа.');
            }
        }
    });

    sock.ev.on('messages.upsert', async (m) => {
        const msg = m.messages[0];
        if (!msg.key.fromMe && m.type === 'notify') {
            const senderPhone = msg.key.remoteJid.replace('@s.whatsapp.net', '');
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
    console.log('Клиент подключился по WebSocket');

    if (currentQr) {
        socket.emit('qr', { qr: currentQr });
    } else if (sock && sock.user) {
        socket.emit('ready');
    }

    socket.on('get_contacts', async () => {
        try {
            const contactsList = [
                { name: 'Тестовый друг', phone: '12345' }
            ];
            socket.emit('contacts', contactsList);
        } catch (e) {
            console.error('Ошибка получения контактов:', e);
        }
    });

    socket.on('send_message', async (data) => {
        try {
            const jid = data.to.includes('@') ? data.to : `${data.to}@s.whatsapp.net`;
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
