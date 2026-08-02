const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const makeWASocket = require('@whiskeysockets/baileys').default;
const { useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const qrcode = require('qrcode');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static('public')); // Убедись, что index.html лежит в папке public (или настрой свой статический путь)

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

    // Входящие сообщения
    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        if (type !== 'notify') return;

        for (const msg of messages) {
            if (!msg.message || msg.key.fromMe) continue;

            const fromJid = msg.key.remoteJid;
            
            // Пропускаем группы, статусы и LID
            if (!fromJid || fromJid.includes('@g.us') || fromJid.includes('@broadcast') || fromJid.includes('@lid')) {
                continue;
            }

            // Извлекаем только чистый номер (до @)
            const cleanPhone = fromJid.split('@')[0].split(':')[0].replace(/\D/g, '');
            const text = msg.message.conversation || msg.message.extendedTextMessage?.text || '';

            io.emit('message', {
                from: cleanPhone, // Отправляем на фронтенд СТРОГО чистые цифры!
                text: text,
                type: 'text'
            });
        }
    });
}

// Работа с веб-сокетами
io.on('connection', (socket) => {
    console.log('🔌 Клиент подключился к Socket.io');

    socket.on('send_message', async (data) => {
        try {
            if (!data.to || !sock) return;

            // 1. СТРОГО очищаем номер от любых не-цифр
            let cleanNumber = String(data.to).replace(/\D/g, '');
            if (cleanNumber.startsWith('8') && cleanNumber.length === 11) {
                cleanNumber = '7' + cleanNumber.slice(1);
            }

            // 2. Сервер САМ прикрепляет @s.whatsapp.net
            const recipientJid = `${cleanNumber}@s.whatsapp.net`;

            console.log(`📤 Отправка сообщения на JID: ${recipientJid}`);

            // 3. Отправка в зависимоти от типа
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
server.listen(PORT, () => console.log(`🚀 Сервер запущен на порту ${PORT}`));
