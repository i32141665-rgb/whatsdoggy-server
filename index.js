const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const makeWASocket = require('@whiskeysockets/baileys').default;
const { useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const qrcode = require('qrcode');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static('public')); // Папка, где лежит index.html

let sock;

async function connectToWhatsApp() {
    const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');

    sock = makeWASocket({
        auth: state,
        printQRInTerminal: true
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            const qrImageUrl = await qrcode.toDataURL(qr);
            io.emit('qr', { qr: qrImageUrl });
        }

        if (connection === 'open') {
            console.log('✅ WhatsApp успешно подключен!');
            io.emit('ready');
        } else if (connection === 'close') {
            const shouldReconnect = (lastDisconnect?.error)?.output?.statusCode !== DisconnectReason.loggedOut;
            console.log('⚠️ Соединение закрыто. Переподключение:', shouldReconnect);
            if (shouldReconnect) {
                connectToWhatsApp();
            }
        }
    });

    // Прием входящих сообщений из WhatsApp
    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        if (type !== 'notify') return;

        for (const msg of messages) {
            if (!msg.message || msg.key.fromMe) continue;

            const fromJid = msg.key.remoteJid;
            
            // Фильтруем группы, статусы и LID
            if (!fromJid || fromJid.includes('@g.us') || fromJid.includes('@broadcast') || fromJid.includes('@lid')) {
                continue;
            }

            // Вырезаем СТРОГО чистые цифры для передачи в браузер
            const cleanPhone = fromJid.split('@')[0].split(':')[0].replace(/\D/g, '');
            const text = msg.message.conversation || msg.message.extendedTextMessage?.text || '';

            io.emit('message', {
                from: cleanPhone, // Отправляем клиенту ЧИСТЫЕ цифры без @s.whatsapp.net
                text: text,
                type: 'text'
            });
        }
    });
}

// Прием команд от браузера через Socket.io
io.on('connection', (socket) => {
    console.log('🔌 Браузер подключился к сокету');

    socket.on('send_message', async (data) => {
        try {
            if (!data.to || !sock) return;

            // 1. Очищаем пришедший номер от не-цифр
            let cleanNumber = String(data.to).replace(/\D/g, '');
            if (cleanNumber.startsWith('8') && cleanNumber.length === 11) {
                cleanNumber = '7' + cleanNumber.slice(1);
            }

            // 2. Сервер САМ прикрепляет @s.whatsapp.net для Baileys
            const recipientJid = `${cleanNumber}@s.whatsapp.net`;

            console.log(`📤 Отправка сообщения на JID: ${recipientJid}`);

            // 3. Отправляем в зависимости от типа (текст / фото / аудио)
            if (data.type === 'text') {
                await sock.sendMessage(recipientJid, { text: data.text });
            } else if (data.type === 'image') {
                const buffer = Buffer.from(data.text.split(',')[1], 'base64');
                await sock.sendMessage(recipientJid, { image: buffer });
            } else if (data.type === 'audio') {
                const buffer = Buffer.from(data.text.split(',')[1], 'base64');
                await sock.sendMessage(recipientJid, { audio: buffer, ptt: true });
            }

        } catch (error) {
            console.error('❌ Ошибка при отправке сообщения:', error);
        }
    });
});

connectToWhatsApp();

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🚀 Сервер WhatsDoggy запущен на порту ${PORT}`));
