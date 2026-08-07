import express from 'express';
import http from 'http';
import { Server } from 'socket.io';
import makeWASocket, { useMultiFileAuthState, DisconnectReason } from '@whiskeysockets/baileys';
import qrcode from 'qrcode';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

let sock = null;

async function connectToWhatsApp() {
    const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');

    sock = makeWASocket({
        auth: state,
        printQRInTerminal: true,
        syncFullHistory: false, // Защита от вылета сервера Render (error 408)
        markOnlineOnConnect: false,
        connectTimeoutMs: 60000,
        defaultQueryTimeoutMs: 60000,
        keepAliveIntervalMs: 25000
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            console.log('⚡ Новый QR-код!');
            try {
                const qrImageUrl = await qrcode.toDataURL(qr);
                io.emit('qr', { qr: qrImageUrl });
            } catch (err) {
                console.error('Ошибка QR:', err);
            }
        }

        if (connection === 'open') {
            console.log('✅ WhatsApp подключен!');
            io.emit('ready');
        } else if (connection === 'close') {
            const statusCode = (lastDisconnect?.error)?.output?.statusCode;
            const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
            console.log(`⚠️ Соединение закрыто (код ${statusCode}).`);
            
            if (sock) {
                sock.ev.removeAllListeners();
            }

            if (shouldReconnect) {
                setTimeout(connectToWhatsApp, 3000);
            }
        }
    });

    // 📩 Получение списка существующих диалогов/чатов
    sock.ev.on('chats.set', ({ chats }) => {
        console.log(`💬 Загружено чатов: ${chats.length}`);
        const chatList = chats
            .filter(c => c.id && !c.id.includes('@g.us') && !c.id.includes('@broadcast'))
            .map(c => ({
                id: c.id.split('@')[0],
                name: c.name || c.id.split('@')[0]
            }));
        io.emit('chat_list', chatList);
    });

    // 📩 Получение входящих сообщений
    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        if (type !== 'notify') return;

        for (const msg of messages) {
            if (!msg.message || msg.key.fromMe) continue;

            const fromJid = msg.key.remoteJid;
            if (!fromJid || fromJid.includes('@g.us') || fromJid.includes('@broadcast') || fromJid.includes('@lid')) {
                continue;
            }

            const cleanPhone = fromJid.split('@')[0].split(':')[0].replace(/\D/g, '');
            const text = msg.message.conversation || msg.message.extendedTextMessage?.text || '';

            io.emit('message', {
                from: cleanPhone,
                text: text,
                type: 'text'
            });
        }
    });
}

// 🔌 Сокетное соединение с сайтом
io.on('connection', (socket) => {
    console.log('🔌 Клиент подключился');

    socket.on('send_message', async (data) => {
        try {
            const rawNumber = data.to || data.phone || data.number;
            const messageText = data.text || data.message;

            if (!rawNumber || !sock) return;

            let cleanNumber = String(rawNumber).replace(/\D/g, '');
            if (cleanNumber.startsWith('8') && cleanNumber.length === 11) {
                cleanNumber = '7' + cleanNumber.slice(1);
            }

            const searchPhone = '+' + cleanNumber;
            let recipientJid = `${cleanNumber}@s.whatsapp.net`;

            try {
                const results = await sock.onWhatsApp(searchPhone);
                if (results && results.length > 0 && results[0].exists) {
                    recipientJid = results[0].jid;
                }
            } catch (wErr) {
                console.error('Ошибка проверки номера:', wErr?.message);
            }

            await sock.sendMessage(recipientJid, { text: messageText });
            console.log(`✅ Сообщение отправлено на ${recipientJid}`);

        } catch (error) {
            console.error('❌ Ошибка отправки:', error);
            socket.emit('error_msg', { message: 'Ошибка при отправке сообщения' });
        }
    });
});

connectToWhatsApp();

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🚀 Сервер WhatsDoggy запущен на порту ${PORT}`));
