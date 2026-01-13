const { Bot, InlineKeyboard, session } = require("grammy");
const postgres = require("postgres");
const cron = require("node-cron");

// --- SOZLAMALAR ---
const BOT_TOKEN = "8344557743:AAGKAJRi5wHynyAPVzTVtKRZz_iEaYb_-hE";
// O'sha o'zingiz topgan 6543 portli linkni qo'ying:
const DATABASE_URL = "postgresql://postgres.eirokehilhbwcazhiglb:Klinika2026Supertizim.@aws-1-eu-central-1.pooler.supabase.com:6543/postgres";
6377333240; // ⚠️ O'Z ID RAQAMINGIZNI YOZING (Buni @userinfobot dan olasiz)

const bot = new Bot(BOT_TOKEN);
const sql = postgres(DATABASE_URL, { ssl: "require" });

// Xotira
bot.use(session({ initial: () => ({ step: "main" }) }));

// --- MENYULAR LOGIKASI ---
async function getMenu(userId, step, ctx) {
  let text = "";
  let keyboard = new InlineKeyboard();

  try {
    // 1. ASOSIY MENYU (KATEGORIYALAR)
    if (step === "main") {
      text = "🏥 **Klinikamizga xush kelibsiz!**\n\nQaysi yo'nalish bo'yicha shifokor kerak?";
      
      // Bazadan kategoriyalarni olamiz (takrorlanmasin uchun DISTINCT)
      const categories = await sql`SELECT DISTINCT category FROM doctors`;
      
      categories.forEach((c, index) => {
        keyboard.text(`👨‍⚕️ ${c.category}`, `cat_${c.category}`);
        if ((index + 1) % 2 === 0) keyboard.row(); // 2 tadan qator qilish
      });
      keyboard.row().text("ℹ️ Mening qabullarim", "my_appointments");
    } 

    // 2. SHIFOKOR TANLASH (Kategoriya bo'yicha)
    else if (step === "doctors") {
      const category = ctx.session.category;
      text = `📂 **${category}** bo'limi.\n\nIltimos, shifokorni va uning toifasini tanlang:`;
      
      const doctors = await sql`SELECT * FROM doctors WHERE category = ${category}`;
      
      doctors.forEach((d) => {
        keyboard.text(`${d.full_name}`, `doc_${d.id}`).row();
      });
      keyboard.text("🔙 Orqaga", "goto_main");
    } 

    // 3. VAQT TANLASH (🟢 Yashil va 🔴 Qizil)
    else if (step === "time") {
      text = "📅 **Ertangi kun uchun vaqt tanlang:**\n\n🟢 - Bo'sh\n🔴 - Band";
      
      const doctorId = ctx.session.doctorId;
      // Shifokor ma'lumotini olamiz
      const doctor = await sql`SELECT * FROM doctors WHERE id = ${doctorId}`;
      
      const startH = doctor[0].start_time; // 9
      const endH = doctor[0].end_time;     // 17

      // Ertangi kun sanasi
      const tomorrow = new Date();
      tomorrow.setDate(tomorrow.getDate() + 1);
      const dateStr = tomorrow.toISOString().split('T')[0]; 

      // Band vaqtlarni olamiz
      const takenSlots = await sql`
        SELECT date_time FROM appointments 
        WHERE doctor_id = ${doctorId} AND status != 'cancelled'
      `;

      let count = 0;
      for (let h = startH; h < endH; h++) {
        const timeStr = `${h}:00`;
        
        // Tekshiramiz: Bandmi?
        const isTaken = takenSlots.some(slot => {
             const slotDate = new Date(slot.date_time);
             return slotDate.toISOString().startsWith(dateStr) && slotDate.getUTCHours() === h;
        });

        const emoji = isTaken ? "🔴" : "🟢";
        const callback = isTaken ? "ignore" : `time_${timeStr}`;
        
        keyboard.text(`${emoji} ${timeStr}`, callback);
        
        count++;
        if (count % 3 === 0) keyboard.row(); // 3 tadan chiroyli setka
      }
      keyboard.row().text("🔙 Orqaga", "goto_doctors");
    }

    // 4. MENING QABULLARIM
    else if (step === "my_appointments") {
        text = "📅 **Sizning faol qabullaringiz:**\n\n";
        const patient = await sql`SELECT id FROM patients WHERE telegram_id = ${userId}`;
        
        if (patient.length > 0) {
            const apps = await sql`
                SELECT a.date_time, d.full_name, d.category
                FROM appointments a
                JOIN doctors d ON a.doctor_id = d.id
                WHERE a.patient_id = ${patient[0].id} AND a.date_time > NOW()
                ORDER BY a.date_time ASC
            `;
            
            if (apps.length === 0) text += "Hozircha qabullar yo'q.";
            
            apps.forEach(app => {
                const date = new Date(app.date_time).toLocaleString();
                text += `🩺 **${app.category}**\n👨‍⚕️ ${app.full_name}\n🕒 ${date}\n\n`;
            });
        } else {
            text += "Siz hali ro'yxatdan o'tmagansiz.";
        }
        keyboard.text("🔙 Bosh menyu", "goto_main");
    }

  } catch (error) {
    console.error("Menyu xatosi:", error);
    text = "⚠️ Xatolik.";
  }
  return { text, keyboard };
}

// --- BOT START ---
bot.command("start", async (ctx) => {
  ctx.session = { step: "main" };
  
  // Bemorni saqlash
  try {
    await sql`
      INSERT INTO patients (telegram_id, full_name, username)
      VALUES (${ctx.from.id}, ${ctx.from.first_name}, ${ctx.from.username || 'user'})
      ON CONFLICT (telegram_id) DO NOTHING
    `;
  } catch (e) { console.log(e); }

  const menu = await getMenu(ctx.from.id, "main", ctx);
  await ctx.reply(menu.text, { reply_markup: menu.keyboard, parse_mode: "Markdown" });
});

// --- TUGMALAR (ROUTER) ---
bot.on("callback_query:data", async (ctx) => {
  const data = ctx.callbackQuery.data;
  const userId = ctx.from.id;

  if (data === "ignore") {
    await ctx.answerCallbackQuery({ text: "Bu vaqt band! Iltimos, yashil vaqtni tanlang.", show_alert: true });
    return;
  }

  // Navigatsiya
  if (data === "goto_main") ctx.session.step = "main";
  else if (data === "goto_doctors") ctx.session.step = "doctors";
  else if (data === "my_appointments") ctx.session.step = "my_appointments";

  // Kategoriya tanlandi
  else if (data.startsWith("cat_")) {
    ctx.session.category = data.split("_")[1];
    ctx.session.step = "doctors";
  }
  // Shifokor tanlandi
  else if (data.startsWith("doc_")) {
    ctx.session.doctorId = data.split("_")[1];
    ctx.session.step = "time";
  }
  // Vaqt tanlandi va SAVED
  else if (data.startsWith("time_")) {
    const time = data.split("_")[1]; // "14:00"
    
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    const dateStr = tomorrow.toISOString().split('T')[0];
    const fullDateTime = `${dateStr}T${time}:00Z`; 

    try {
      const patient = await sql`SELECT id, full_name, username FROM patients WHERE telegram_id = ${userId}`;
      const doctor = await sql`SELECT full_name, category FROM doctors WHERE id = ${ctx.session.doctorId}`;
      
      if (patient.length > 0) {
        // 1. Bazaga yozish
        await sql`
          INSERT INTO appointments (date_time, doctor_id, patient_id)
          VALUES (${fullDateTime}, ${ctx.session.doctorId}, ${patient[0].id})
        `;
        
        // 2. Mijozga javob
        await ctx.deleteMessage();
        await ctx.reply(`✅ **Qabul tasdiqlandi!**\n\n👨‍⚕️ Shifokor: ${doctor[0].full_name}\n📂 Yo'nalish: ${doctor[0].category}\n🕒 Vaqt: Ertaga soat ${time} da.\n\n1 soat oldin eslatma yuboramiz!`);
        
        // 3. ADMIN STATISTIKA (Admin panel o'rniga)
        try {
            const adminMsg = `🆕 **Yangi Mijoz!**\n\n👤 Bemor: ${patient[0].full_name} (@${patient[0].username})\n👨‍⚕️ Shifokor: ${doctor[0].full_name}\n🕒 Vaqt: ${time}`;
            await bot.api.sendMessage(ADMIN_ID, adminMsg, { parse_mode: "Markdown" });
        } catch (e) { 
            console.log("Admin ID xato yoki bot adminni bloklagan"); 
        }

        ctx.session.step = "main";
        const menu = await getMenu(userId, "main", ctx);
        await ctx.reply(menu.text, { reply_markup: menu.keyboard, parse_mode: "Markdown" });
        return;
      }
    } catch (e) {
      await ctx.answerCallbackQuery({ text: "Uzur, kimdir sizdan oldin ulgurdi!", show_alert: true });
      return;
    }
  }

  // Ekranni yangilash
  const menu = await getMenu(userId, ctx.session.step, ctx);
  try {
    await ctx.editMessageText(menu.text, { reply_markup: menu.keyboard, parse_mode: "Markdown" });
  } catch (e) {}
  await ctx.answerCallbackQuery();
});

// --- ESLATMA TIZIMI (CRON JOB) ---
// Har daqiqada tekshiradi
cron.schedule('* * * * *', async () => {
    try {
        // 1 soatdan keyin bo'ladigan qabullarni topamiz
        const upcoming = await sql`
            SELECT a.id, p.telegram_id, d.full_name, a.date_time 
            FROM appointments a
            JOIN patients p ON a.patient_id = p.id
            JOIN doctors d ON a.doctor_id = d.id
            WHERE a.date_time BETWEEN NOW() + INTERVAL '59 minutes' AND NOW() + INTERVAL '61 minutes'
            AND a.status = 'confirmed'
        `;

        for (const app of upcoming) {
            const timeStr = new Date(app.date_time).getHours() + ":00";
            await bot.api.sendMessage(
                Number(app.telegram_id), 
                `⏰ **ESLATMA!**\n\nHurmatli mijoz, 1 soatdan keyin (${timeStr} da) Dr. ${app.full_name} qabuliga yozilgansiz.\nIltimos, kechikmang!`
            );
            console.log("Eslatma yuborildi:", app.id);
        }
    } catch (e) {
        console.error("Cron xatosi:", e);
    }
});

bot.start();
console.log("🚀 Super Bot ishga tushdi!");
