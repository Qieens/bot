// WhatsApp Bot — Final Stable Version
import * as baileys from '@whiskeysockets/baileys'
import { Boom } from '@hapi/boom'
import { readFileSync, writeFileSync, existsSync } from 'fs'
import qrcode from 'qrcode-terminal'
import pino from 'pino'

const {
  makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  getContentType
} = baileys

const logger = pino({
  transport: {
    target: 'pino-pretty',
    options: { colorize: true }
  },
  level: 'info'
})

const OWNER_NUMBER = '628975539822@s.whatsapp.net'
const allowedGroups = ['120363419880680909@g.us']
const maintenanceFile = './maintenance.json'

let sock
let isRestarting = false
let autoWarning = false
let warningCooldown = false

const isAdmin = async (groupId, userId, sock) => {
  try {
    if (!userId.endsWith('@s.whatsapp.net')) userId += '@s.whatsapp.net'
    const metadata = await sock.groupMetadata(groupId)
    const participant = metadata.participants.find(p => p.id === userId)
    return participant?.admin === 'admin' || participant?.admin === 'superadmin'
  } catch (error) {
    logger.error('Error checking admin status:', error)
    return false
  }
}

const sendErrorToOwner = async (err, label = 'Error') => {
  try {
    await sock.sendMessage(OWNER_NUMBER, {
      text: `🚨 *${label}*\n\n\`\`\`${(err.stack || err.toString()).slice(0, 4000)}\`\`\``
    })
  } catch (e) {
    logger.error('Gagal kirim log ke owner:', e)
  }
}

async function connectToWhatsApp() {
  try {
    const { state, saveCreds } = await useMultiFileAuthState('auth')
    const { version } = await fetchLatestBaileysVersion()
    sock = makeWASocket({ version, logger, auth: state })

    sock.ev.on('creds.update', saveCreds)
    sock.ev.on('connection.update', ({ connection, lastDisconnect, qr }) => {
      if (qr) qrcode.generate(qr, { small: true })
      if (connection === 'close') {
        const shouldReconnect = lastDisconnect?.error instanceof Boom
          ? lastDisconnect.error.output.statusCode !== DisconnectReason.loggedOut
          : true
        logger.warn('Connection closed. Reconnecting:', shouldReconnect)
        if (shouldReconnect) connectToWhatsApp()
      } else if (connection === 'open') {
        logger.info('✅ Bot connected')
      }
    })

    sock.ev.on('messages.upsert', async ({ messages }) => {
      try {
        const msg = messages[0]
        if (!msg.message || msg.key.fromMe) return

        const from = msg.key.remoteJid
        const sender = msg.key.participant || msg.key.remoteJid
        const isGroup = from.endsWith('@g.us')
        const type = getContentType(msg.message)
        const body = type === 'conversation' ? msg.message.conversation : msg.message[type]?.text || ''

        let maintenance = false
        if (existsSync(maintenanceFile)) {
          const data = JSON.parse(readFileSync(maintenanceFile, 'utf-8'))
          maintenance = data.active
        }

        if (maintenance && sender !== OWNER_NUMBER) return

        if (isGroup && !allowedGroups.includes(from)) {
          await sock.sendMessage(from, {
            text: '👋 Maaf, bot ini hanya diizinkan aktif di grup tertentu.\nKeluar otomatis dari grup ini.'
          })
          logger.warn(`Grup ${from} tidak di whitelist. Bot akan keluar.`)
          await sock.groupLeave(from)
          return
        }

        if (isGroup && type === 'extendedTextMessage') {
          const text = msg.message.extendedTextMessage?.text || ''
          if (/chat\.whatsapp\.com\//i.test(text) && !(await isAdmin(from, sender, sock))) {
            await sock.sendMessage(from, { text: '🔗 Link grup terdeteksi dan akan dihapus.' })
            await sock.groupParticipantsUpdate(from, [sender], 'remove')
          }
        }

        if (body.startsWith('.')) {
          const [command, ...args] = body.trim().split(/ +/)
          const text = body
          const fallback = { text: '❌ Kamu bukan admin.' }

          switch (command) {
            case '.admin':
            case '.kick':
            case '.add':
            case '.promote':
            case '.demote':
            case '.close':
            case '.open':
            case '.setname':
            case '.setdesc':
            case '.tagall':
            case '.togglewarning':
              if (!isGroup) return
              if (!(await isAdmin(from, sender, sock))) return sock.sendMessage(from, fallback, { quoted: msg })
              break
          }

          switch (command) {
            case '.menuadmin':
              await sock.sendMessage(from, {
                text: `╭───❏ 🛠 ADMIN MENU ❏───╮
│
├ ✦ .kick @user
├ ✦ .add <nomor>
├ ✦ .promote @user
├ ✦ .demote @user
├ ✦ .open (membuka grup) 
├ ✦ .close (menutup grup)
├ ✦ .setname <nama grup>
├ ✦ .setdesc <deskripsi grup>
├ ✦ .giveaway (comingsoon)
└ ✦ .tagall [pesan opsional]

📌 Khusus admin grup saja!
🤖 Bot by: @qieen.store
╰──────────────────────╯`
              })
              break

            case '.kick': {
              const mention = msg.message.extendedTextMessage?.contextInfo?.mentionedJid || []
              if (mention.length) {
                await sock.groupParticipantsUpdate(from, mention, 'remove')
                await sock.sendMessage(from, { text: '✅ Anggota berhasil dikeluarkan.' })
              }
              break
            }

            case '.add': {
  const number = args[0]?.replace(/\D/g, '')
  if (!number) return await sock.sendMessage(from, { text: `❌ Format salah. Gunakan: .add 628xxxxx` })

  const jid = `${number}@s.whatsapp.net`
  try {
    const result = await sock.groupParticipantsUpdate(from, [jid], 'add')
    const status = result[0]?.status

    if (status === '200') {
      await sock.sendMessage(from, { text: '✅ Anggota berhasil ditambahkan.' })
    } else {
      let reason = {
        '403': '❌ Tidak diizinkan menambahkan (mungkin sudah keluar sebelumnya)',
        '408': '❌ Nomor tidak ditemukan atau tidak aktif di WhatsApp',
        '409': '❌ Sudah jadi anggota grup',
        '500': '❌ Terjadi kesalahan dari server WhatsApp'
      }[status] || `❌ Gagal menambahkan (kode: ${status})`

      await sock.sendMessage(from, { text: reason })

      // Jika masih memungkinkan, buatkan link undangan
      if (status === '403') {
        try {
          const inviteCode = await sock.groupInviteCode(from)
          await sock.sendMessage(from, {
            text: `📨 Kirim link ini ke member:\nhttps://chat.whatsapp.com/${inviteCode}`
          })
        } catch {
          await sock.sendMessage(from, { text: '⚠️ Gagal membuat link undangan.' })
        }
      }
    }
  } catch (err) {
    await sock.sendMessage(from, { text: `❌ Error: ${(err.message || '').slice(0, 100)}` })
    await sendErrorToOwner(err, 'Gagal Menambahkan Anggota')
  }
  break
}

            case '.promote': {
              const promoteJid = msg.message.extendedTextMessage?.contextInfo?.mentionedJid || []
              if (promoteJid.length) {
                await sock.groupParticipantsUpdate(from, promoteJid, 'promote')
                await sock.sendMessage(from, { text: '✅ Anggota berhasil dipromosikan.' })
              }
              break
            }

            case '.demote': {
              const demoteJid = msg.message.extendedTextMessage?.contextInfo?.mentionedJid || []
              if (demoteJid.length) {
                await sock.groupParticipantsUpdate(from, demoteJid, 'demote')
                await sock.sendMessage(from, { text: '✅ Anggota berhasil didemosi.' })
              }
              break
            }

            case '.close':
              await sock.groupSettingUpdate(from, 'announcement')
              await sock.sendMessage(from, { text: '🔒 Grup ditutup hanya admin yang bisa chat.' })
              break

            case '.open':
              await sock.groupSettingUpdate(from, 'not_announcement')
              await sock.sendMessage(from, { text: '🔓 Grup dibuka semua member bisa chat.' })
              break

            case '.setname': {
              const newName = text.split(' ').slice(1).join(' ')
              if (newName) {
                await sock.groupUpdateSubject(from, newName)
                await sock.sendMessage(from, { text: '✅ Nama grup berhasil diubah.' })
              }
              break
            }

            case '.setdesc': {
              const newDesc = text.split(' ').slice(1).join(' ')
              if (newDesc) {
                await sock.groupUpdateDescription(from, newDesc)
                await sock.sendMessage(from, { text: '✅ Deskripsi grup berhasil diubah.' })
              }
              break
            }

            case '.tagall': {
              const metadata = await sock.groupMetadata(from)
              const mentions = metadata.participants.map(p => p.id)
              const customText = text.trim().split(' ').slice(1).join(' ')
              const messageText = customText.length > 0 ? customText : '📢 Semua member telah ditandai.'
              await sock.sendMessage(from, { text: messageText, mentions }, { quoted: msg })
              break
            }

            case '.togglewarning':
              autoWarning = !autoWarning
              await sock.sendMessage(from, {
                text: `✅ Auto warning telah *${autoWarning ? 'diaktifkan' : 'dinonaktifkan'}*.`
              })
              break

            case '.maintenance':
              if (sender !== OWNER_NUMBER) return
              maintenance = !maintenance
              writeFileSync(maintenanceFile, JSON.stringify({ active: maintenance }, null, 2))
              await sock.sendMessage(from, {
                text: `🔧 Mode maintenance *${maintenance ? 'diaktifkan' : 'dinonaktifkan'}*.`
              })
              try {
                const allGroups = await sock.groupFetchAllParticipating()
                for (const group of Object.values(allGroups)) {
                  if (allowedGroups.includes(group.id)) {
                    await sock.sendMessage(group.id, {
                      text: maintenance
                        ? '⛔ Bot sedang dalam mode *maintenance*. Harap menunggu hingga bot aktif kembali.'
                        : '✅ Bot telah kembali *aktif*. Silakan lanjutkan aktivitas seperti biasa.'
                    })
                  }
                }
              } catch (err) {
                logger.error('❌ Gagal broadcast maintenance:', err)
              }
              break
          }
        }
      } catch (err) {
        logger.error('❌ Error di message handler:', err)
        await sendErrorToOwner(err, 'Error di Message Handler')
      }
    })

    // Interval Auto Warning
    setInterval(async () => {
      if (!autoWarning || warningCooldown || !sock) return
      warningCooldown = true
      try {
        const groups = await sock.groupFetchAllParticipating()
        for (const group of Object.values(groups)) {
          if (allowedGroups.includes(group.id)) {
            await sock.sendMessage(group.id, {
              text: '⚠️ Demi keamanan, mohon selalu gunakan *Midman Admin* saat transaksi di grup ini.'
            })
          }
        }
      } catch (err) {
        logger.error('Gagal kirim warning:', err)
      } finally {
        setTimeout(() => (warningCooldown = false), 30 * 60 * 1000)
      }
    }, 60 * 1000)

  } catch (error) {
    logger.fatal('Error during connection:', error)
    await sendErrorToOwner(error, 'Fatal Error saat Connect')
    if (!isRestarting) {
      isRestarting = true
      setTimeout(connectToWhatsApp, 10000)
    }
  }
}

// Global Error Handling
process.on('uncaughtException', async (err) => {
  logger.error('❌ Uncaught Exception:', err)
  await sendErrorToOwner(err, 'Uncaught Exception')
})

process.on('unhandledRejection', async (reason) => {
  logger.error('❌ Unhandled Rejection:', reason)
  await sendErrorToOwner(reason, 'Unhandled Rejection')
})

// Start Bot
connectToWhatsApp()
