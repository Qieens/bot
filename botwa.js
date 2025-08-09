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

// Logger konfigurasi: tampil rapi di console
const logger = pino({
  transport: { target: 'pino-pretty', options: { colorize: true } },
  level: 'info'
})

// ======= KONFIGURASI =======
const OWNER_NUMBER = '628975539822@s.whatsapp.net'
const allowedGroups = ['120363419880680909@g.us']
const maintenanceFile = './maintenance.json'
const GIVEAWAY_FILE = './giveaway.json'

let sock
let maintenance = false
let autoWarning = false
let warningCooldown = false

// ======= DATA GIVEAWAY =======
let giveawayData = {}
if (existsSync(GIVEAWAY_FILE)) {
  try {
    giveawayData = JSON.parse(readFileSync(GIVEAWAY_FILE))
  } catch {
    giveawayData = {}
  }
}
const saveGiveaway = () => {
  writeFileSync(GIVEAWAY_FILE, JSON.stringify(giveawayData, null, 2))
}

// ======= UTILS =======

// Parsing durasi giveaway dari format 1d2h30m
function parseDuration(text) {
  const regex = /(\d+d)?(\d+h)?(\d+m)?/i
  const match = text.match(regex)
  if (!match) return 0
  let totalMs = 0
  if (match[1]) totalMs += parseInt(match[1]) * 24 * 60 * 60 * 1000
  if (match[2]) totalMs += parseInt(match[2]) * 60 * 60 * 1000
  if (match[3]) totalMs += parseInt(match[3]) * 60 * 1000
  return totalMs
}

// Mengacak dan memilih pemenang giveaway
function pickWinners(participants, count) {
  if (participants.length <= count) return participants
  const winners = []
  const copy = [...participants]
  while (winners.length < count && copy.length) {
    const idx = Math.floor(Math.random() * copy.length)
    winners.push(copy.splice(idx, 1)[0])
  }
  return winners
}

// Mengecek giveaway aktif di grup
const activeGiveaway = (groupId) => giveawayData[groupId]?.isActive === true

// Cek apakah user admin di grup
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

// Kirim error ke owner via WA
const sendErrorToOwner = async (err, label = 'Error') => {
  try {
    await sock.sendMessage(OWNER_NUMBER, {
      text: `🚨 *${label}*\n\n\`\`\`\n${(err.stack || err.toString()).slice(0, 4000)}\n\`\`\``
    })
  } catch (e) {
    logger.error('Gagal kirim log ke owner:', e)
  }
}

// Update otomatis bot dari GitHub (file botwa.js)
async function autoUpdateBot(sock, from) {
  try {
    const response = await fetch('https://raw.githubusercontent.com/Qieens/bot/main/botwa.js')
    if (!response.ok) throw new Error(`HTTP Error ${response.status}`)
    const updatedCode = await response.text()
    writeFileSync('./botwa.js', updatedCode)
    await sock.sendMessage(from, { text: '✅ Bot berhasil diperbarui. Restarting...' })
    process.exit(0) // Restart otomatis jika pakai pm2 atau shell loop
  } catch (err) {
    await sock.sendMessage(from, { text: `❌ Gagal memperbarui bot: ${err.message}` })
    logger.error('Auto Update Error:', err)
  }
}

// ======= MAIN FUNCTION CONNECT =======
async function connectToWhatsApp() {
  try {
    const { state, saveCreds } = await useMultiFileAuthState('auth')
    const { version } = await fetchLatestBaileysVersion()

    sock = makeWASocket({ version, logger, auth: state })

    sock.ev.on('creds.update', saveCreds)

    sock.ev.on('connection.update', ({ connection, lastDisconnect, qr }) => {
      if (qr) qrcode.generate(qr, { small: true })

      if (connection === 'close') {
        const shouldReconnect =
          lastDisconnect?.error instanceof Boom
            ? lastDisconnect.error.output.statusCode !== DisconnectReason.loggedOut
            : true
        logger.warn('Connection closed. Reconnecting:', shouldReconnect)
        if (shouldReconnect) connectToWhatsApp()
      } else if (connection === 'open') {
        logger.info('✅ Bot connected')
      }
    })

    // Load status maintenance jika ada
    if (existsSync(maintenanceFile)) {
      maintenance = JSON.parse(readFileSync(maintenanceFile)).active
    }

    // Interval cek giveaway, umumkan pemenang jika waktu habis
    setInterval(async () => {
      if (!sock) return
      const now = Date.now()
      for (const [groupId, gdata] of Object.entries(giveawayData)) {
        if (!gdata.isActive) continue
        if (now >= gdata.endTime) {
          gdata.isActive = false
          const winners = pickWinners(gdata.participants, gdata.winnerCount)
          const winnerMentions = winners
          const text = winners.length
            ? `🎉 Giveaway *${gdata.description}* selesai!\n\n🏆 Pemenang:\n${winners.map(w => '@' + w.split('@')[0]).join('\n')}`
            : `⚠️ Giveaway *${gdata.description}* selesai tapi tidak ada peserta.`

          try {
            await sock.sendMessage(groupId, { text, mentions: winnerMentions })
          } catch (e) {
            logger.error('Gagal umumkan pemenang giveaway:', e)
          }
          saveGiveaway()
        }
      }
    }, 60 * 1000)

    // Event pesan masuk
    sock.ev.on('messages.upsert', async ({ messages }) => {
      try {
        const msg = messages[0]
        if (!msg.message || msg.key.fromMe) return

        const from = msg.key.remoteJid
        const sender = msg.key.participant || msg.key.remoteJid
        const isGroup = from.endsWith('@g.us')
        const type = getContentType(msg.message)
        const body =
          type === 'conversation'
            ? msg.message.conversation
            : msg.message[type]?.text || ''

        if (maintenance && sender !== OWNER_NUMBER) return

        // Auto keluar jika grup tidak di whitelist
        if (isGroup && !allowedGroups.includes(from)) {
          await sock.sendMessage(from, {
            text: '👋 Maaf, bot ini hanya diizinkan aktif di grup tertentu.\nKeluar otomatis dari grup ini.'
          })
          logger.warn(`Grup ${from} tidak di whitelist. Bot akan keluar.`)
          await sock.groupLeave(from)
          return
        }

        // Anti link grup kecuali admin
        if (isGroup && type === 'extendedTextMessage') {
          const text = msg.message.extendedTextMessage?.text || ''
          if (/chat\.whatsapp\.com\//i.test(text) && !(await isAdmin(from, sender, sock))) {
            await sock.sendMessage(from, { text: '🔗 Link grup terdeteksi dan akan dihapus.' })
            await sock.groupParticipantsUpdate(from, [sender], 'remove')
            return
          }
        }

        if (!body.startsWith('.')) return

        // Parsing command dan args
        const [command, ...args] = body.trim().split(/ +/)
        const fallback = { text: '*Kamu bukan admin!!*' }
        const groupOnlyCommands = [
          '.admin', '.kick', '.add', '.promote', '.demote',
          '.close', '.open', '.setname', '.setdesc', '.tagall', '.togglewarning',
          '.giveaway','.endgiveaway', '.listgiveaway'
        ]

        if (groupOnlyCommands.includes(command)) {
          if (!isGroup) return
          if (!(await isAdmin(from, sender, sock))) return sock.sendMessage(from, fallback, { quoted: msg })
        }

        switch (command) {
          case '.menu':
            await sock.sendMessage(from, {
              text: `╭───❏ 🛠 ADMIN MENU ❏───╮
│
├ ✦ .kick @user
├ ✦ .add 62xxx
├ ✦ .promote @user
├ ✦ .demote @user
├ ✦ .open (membuka grup)
├ ✦ .close (menutup grup)
├ ✦ .setname <nama grup>
├ ✦ .setdesc <deskripsi grup>
│
├ ✦ .giveaway (deskripsi, jumlah_pemenang, durasi)
├ ✦ .joingiveaway
├ ✦ .listgiveaway
├ ✦ .endgiveaway
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
              await sock.sendMessage(from, { text: '*Anggota berhasil dikeluarkan.* ✅' })
            }
            break
          }

          case '.add': {
            const number = args[0]?.replace(/\D/g, '')
            if (!number) return await sock.sendMessage(from, { text: `*Format salah. Gunakan: .add 628xxxxx*` })
            const jid = `${number}@s.whatsapp.net`
            try {
              const result = await sock.groupParticipantsUpdate(from, [jid], 'add')
              if (result[0]?.status === '200') {
                await sock.sendMessage(from, { text: '*Anggota berhasil ditambahkan.* ✅' })
              } else {
                const inviteCode = await sock.groupInviteCode(from)
                await sock.sendMessage(from, {
                  text: `❌ Gagal menambahkan langsung.\n📨 Kirim link ini ke member:\nhttps://chat.whatsapp.com/${inviteCode}`
                })
              }
            } catch (err) {
              await sendErrorToOwner(err, 'Gagal Menambahkan Anggota')
            }
            break
          }

          case '.promote': {
            const promoteJid = msg.message.extendedTextMessage?.contextInfo?.mentionedJid || []
            if (promoteJid.length) {
              await sock.groupParticipantsUpdate(from, promoteJid, 'promote')
              await sock.sendMessage(from, { text: '*Anggota berhasil di jadikan admin.*' })
            }
            break
          }

          case '.demote': {
            const demoteJid = msg.message.extendedTextMessage?.contextInfo?.mentionedJid || []
            if (demoteJid.length) {
              await sock.groupParticipantsUpdate(from, demoteJid, 'demote')
              await sock.sendMessage(from, { text: '*Anggota berhasil di demote.*' })
            }
            break
          }

          case '.close':
            await sock.groupSettingUpdate(from, 'announcement')
            await sock.sendMessage(from, { text: '🔒 *Grup ditutup hanya admin yang bisa chat.*' })
            break

          case '.open':
            await sock.groupSettingUpdate(from, 'not_announcement')
            await sock.sendMessage(from, { text: '🔓 *Grup dibuka semua member bisa chat.*' })
            break

          case '.setname': {
            const newName = args.join(' ')
            if (newName) {
              await sock.groupUpdateSubject(from, newName)
              await sock.sendMessage(from, { text: '*Nama grup berhasil diubah.*' })
            }
            break
          }

          case '.setdesc': {
            const newDesc = args.join(' ')
            if (newDesc) {
              await sock.groupUpdateDescription(from, newDesc)
              await sock.sendMessage(from, { text: '*Deskripsi grup berhasil diubah.*' })
            }
            break
          }

          case '.tagall': {
            const metadata = await sock.groupMetadata(from)
            const mentions = metadata.participants.map(p => p.id)
            const customText = args.join(' ') || ' '
            await sock.sendMessage(from, { text: customText, mentions }, { quoted: msg })
            break
          }

          case '.togglewarning':
            autoWarning = !autoWarning
            await sock.sendMessage(from, {
              text: `✅ Auto warning telah *${autoWarning ? 'diaktifkan' : 'dinonaktifkan'}*.`
            })
            break

          case '.maintenance': {
            if (isGroup) return
            if (sender !== OWNER_NUMBER) return
            const mode = args[0]?.toLowerCase()
            if (!mode) {
              await sock.sendMessage(from, {
                text: `🔧 Gunakan perintah:\n\n.maintenance on\n.maintenance off\n.maintenance (cek status)`
              })
              break
            }
            if (mode === 'on' || mode === 'off') {
              maintenance = mode === 'on'
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
                        ? '⛔ *Bot sedang dalam mode maintenance. Harap menunggu hingga bot aktif kembali.*'
                        : '✅ *Bot telah kembali aktif. Silakan lanjutkan aktivitas seperti biasa.*'
                    })
                  }
                }
              } catch (err) {
                await sendErrorToOwner(err, 'Gagal Kirim Notifikasi Maintenance')
              }
              break
            } else {
              await sock.sendMessage(from, {
                text: `❌ Perintah tidak dikenali.\nGunakan:\n.maintenance on / off / [kosong untuk cek status]`
              })
              break
            }
          }

          case '.restart': {
            if (isGroup) return
            if (sender !== OWNER_NUMBER) return sock.sendMessage(from, { text: '❌ Hanya owner yang bisa me-restart bot.' })
            await sock.sendMessage(from, { text: '♻️ Mengunduh update terbaru dan me-restart bot...' })
            await autoUpdateBot(sock, from)
            break
          }

          // ===== GIVEAWAY =====
          case '.giveaway': {
            if (!isGroup) return
            if (!(await isAdmin(from, sender, sock))) {
              return sock.sendMessage(from, { text: '*Hanya admin yang boleh membuat giveaway.*' }, { quoted: msg })
            }

            // Format: .giveaway Deskripsi | JumlahPemenang | Durasi (1d2h30m)
            const params = body.slice(9).split(',').map(s => s.trim())
            if (params.length !== 3) {
              await sock.sendMessage(from, { text: '❌ Format salah.\n.giveaway <deskripsi> | <jumlah_pemenang> | <durasi>\nContoh: .giveaway Hadiah Bot | 3 | 1d2h30m' })
              break
            }

            const [description, winnerCountStr, durationStr] = params
            const winnerCount = parseInt(winnerCountStr)
            if (isNaN(winnerCount) || winnerCount < 1) {
              await sock.sendMessage(from, { text: '*Jumlah pemenang harus angka lebih dari 0.*' })
              break
            }

            const durationMs = parseDuration(durationStr.toLowerCase())
            if (durationMs <= 0) {
              await sock.sendMessage(from, { text: '*Durasi tidak valid. Contoh: 1d2h30m*' })
              break
            }

            if (activeGiveaway(from)) {
              await sock.sendMessage(from, { text: '❌ Sudah ada giveaway aktif di grup ini.' })
              break
            }

            const startTime = Date.now()
            const endTime = startTime + durationMs

            giveawayData[from] = {
              description,
              winnerCount,
              startTime,
              endTime,
              participants: [],
              isActive: true
            }
            saveGiveaway()

            const formatTime = (ts) => new Date(ts).toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' })

            await sock.sendMessage(from, {
              text:
                `🎉 *GIVEAWAY DIMULAI!*\n\n` +
                `📦 Deskripsi : *${description}*\n` +
                `🏆 Jumlah Pemenang : *${winnerCount}*\n` +
                `⏳ Durasi : *${durationStr}*\n` +
                `🕒 Mulai : ${formatTime(startTime)}\n` +
                `⏰ Berakhir : ${formatTime(endTime)}\n\n` +
                `📥 Ketik *.joingiveaway* untuk ikut berpartisipasi!`
            })
            break
          }

          case '.joingiveaway': {
            if (!isGroup) return
            if (!activeGiveaway(from)) {
              await sock.sendMessage(from, { text: '❌ Tidak ada giveaway aktif di grup ini.' })
              break
            }
            const g = giveawayData[from]
            if (g.participants.includes(sender)) {
              await sock.sendMessage(from, { text: '⚠️ Kamu sudah ikut giveaway ini.' })
              break
            }
            g.participants.push(sender)
            saveGiveaway()
            await sock.sendMessage(from, { text: '✅ Kamu berhasil ikut giveaway! Semoga beruntung.' })
            break
          }

          case '.endgiveaway': {
            if (!isGroup) return
            if (!(await isAdmin(from, sender, sock))) return sock.sendMessage(from, { text: '❌ Hanya admin yang boleh mengakhiri giveaway.' }, { quoted: msg })

            if (!activeGiveaway(from)) {
              await sock.sendMessage(from, { text: '❌ Tidak ada giveaway aktif di grup ini.' })
              break
            }

            giveawayData[from].isActive = false
            saveGiveaway()
            await sock.sendMessage(from, { text: '⚠️ Giveaway telah dibatalkan oleh admin.' })
            break
          }

          case '.listgiveaway': {
            if (!isGroup) return
            if (!(await isAdmin(from, sender, sock))) return sock.sendMessage(from, { text: '❌ Hanya admin yang boleh melihat daftar peserta.' }, { quoted: msg })

            if (!activeGiveaway(from)) {
              await sock.sendMessage(from, { text: '❌ Tidak ada giveaway aktif di grup ini.' })
              break
            }

            const g = giveawayData[from]
            if (g.participants.length === 0) {
              await sock.sendMessage(from, { text: 'ℹ️ Belum ada peserta yang ikut giveaway.' })
            } else {
              const listText = g.participants.map((p, i) => `${i + 1}. @${p.split('@')[0]}`).join('\n')
              await sock.sendMessage(from, { text: `📋 Daftar peserta giveaway:\n${listText}`, mentions: g.participants })
            }
            break
          }
        }
      } catch (err) {
        logger.error('Gagal memproses pesan:', err)
        await sendErrorToOwner(err, 'Message Handling Error')
      }
    })

    // Interval auto warning tiap 30 menit kalau diaktifkan
    setInterval(async () => {
      if (!autoWarning || warningCooldown || !sock || maintenance) return
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
        setTimeout(() => (warningCooldown = false), 30 * 60 * 1000) // 30 menit cooldown
      }
    }, 60 * 1000) // cek tiap menit

  } catch (error) {
    logger.fatal('Error during connection:', error)
    await sendErrorToOwner(error, 'Fatal Error saat Connect')
    setTimeout(connectToWhatsApp, 10000) // coba reconnect 10 detik kemudian
  }
}

// Tangani error uncaught dan unhandled rejections
process.on('uncaughtException', async (err) => {
  logger.error('❌ Uncaught Exception:', err)
  await sendErrorToOwner(err, 'Uncaught Exception')
})
process.on('unhandledRejection', async (reason) => {
  logger.error('❌ Unhandled Rejection:', reason)
  await sendErrorToOwner(reason, 'Unhandled Rejection')
})

// Mulai koneksi
connectToWhatsApp()
