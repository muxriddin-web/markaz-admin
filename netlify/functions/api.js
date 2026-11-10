// O'quv markazi API — Netlify Function + MongoDB Atlas
// Muhit o'zgaruvchisi: MONGODB_URI (majburiy), MONGODB_DB (ixtiyoriy, standart: "markaz")
const { MongoClient } = require("mongodb"), crypto = require("crypto"), { promisify } = require("util");
const scrypt = promisify(crypto.scrypt);
let cache;
function db() {
  if (!cache) cache = (async () => {
    const c = await new MongoClient(process.env.MONGODB_URI).connect(), d = c.db(process.env.MONGODB_DB || "markaz");
    await Promise.all([d.collection("sessions").createIndex({ exp: 1 }, { expireAfterSeconds: 0 }), d.collection("attempts").createIndex({ at: 1 }, { expireAfterSeconds: 600 })]);
    return d;
  })().catch(e => { cache = null; throw e; });
  return cache;
}
const send = (c, o) => ({ statusCode: c, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" }, body: JSON.stringify(o) });
const th = t => crypto.createHash("sha256").update(t).digest("hex");
const str = (v, n) => String(v ?? "").slice(0, n), num = v => Number.isFinite(+v) ? +v : 0, MK = /^20\d{2}-(0[1-9]|1[0-2])$/;
const DD = /^\d{4}-\d{2}-\d{2}$/, DT = /^20\d{2}-(0[1-9]|1[0-2])(-(0[1-9]|[12]\d|3[01]))?$/;
const cs = s => {
  const start = MK.test(s.start) ? s.start : "2000-01", fee = Math.max(0, num(s.fee));
  const tariffs = (Array.isArray(s.tariffs) ? s.tariffs : []).slice(0, 60).map(x => ({ from: Math.min(1000, Math.max(1, Math.floor(num(x && x.from)))), fee: Math.max(0, num(x && x.fee)), lessons: Math.min(500, Math.max(1, Math.floor(num(x && x.lessons)) || 12)) })).sort((p, q) => p.from - q.from);
  return { id: num(s.id), name: str(s.name, 100), phone: str(s.phone, 30), fee, tariffs, start, joined: DD.test(s.joined) ? s.joined : "", bstart: DT.test(s.bstart) ? s.bstart : "", course: str(s.course, 60), branch: str(s.branch, 40), period: str(s.period, 20), time: str(s.time, 10), desc: str(s.desc, 500) };
};
const cp = p => ({ id: num(p.id), sid: num(p.sid), month: MK.test(p.month) ? p.month : "2000-01", amount: Math.max(0, Math.round(num(p.amount))), date: str(p.date, 10) });
const snap = u => ({ students: u.students, payments: u.payments, groups: u.groups || [], version: u.version });

exports.handler = async (event) => {
  try {
    const route = event.path.split("/").filter(Boolean).pop(), m = event.httpMethod, H = event.headers || {};
    const body = () => { try { return JSON.parse(event.isBase64Encoded ? Buffer.from(event.body, "base64").toString() : event.body || "{}"); } catch (e) { return null; } };
    const d = await db(), Users = d.collection("users"), Ses = d.collection("sessions"), Att = d.collection("attempts");

    if (m === "POST" && (route === "register" || route === "login")) {
      const b = body(); if (!b) return send(400, { error: "Noto'g'ri so'rov" });
      const l = str(b.login, 100).trim().toLowerCase(), p = str(b.pass, 101);
      if (l.length < 3 || l.length > 30 || /\s/.test(l)) return send(400, { error: "Login 3 tadan 30 tagacha belgi bo'lsin, bo'sh joysiz (masalan: admin1)" });
      if (p.length < 4 || p.length > 100) return send(400, { error: "Parol kamida 4 ta belgi bo'lishi kerak" });
      if (route === "register") {
        const salt = crypto.randomBytes(16).toString("hex");
        try { await Users.insertOne({ _id: l, salt, hash: (await scrypt(p, salt, 64)).toString("hex"), students: [], payments: [], version: 1, createdAt: new Date() }); }
        catch (e) { if (e.code === 11000) return send(409, { error: "Bu login band. Boshqa nom tanlang yoki «Kirish»dan kiring" }); throw e; }
      } else {
        const ip = H["x-nf-client-connection-ip"] || (H["x-forwarded-for"] || "").split(",")[0].trim() || "?";
        if (await Att.countDocuments({ ip }) >= 15) return send(429, { error: "Juda ko'p urinish. 10 daqiqadan keyin qayta urinib ko'ring" });
        const x = await Users.findOne({ _id: l });
        const ok = x && crypto.timingSafeEqual(await scrypt(p, x.salt, 64), Buffer.from(x.hash, "hex"));
        if (!ok) { await Att.insertOne({ ip, at: new Date() }); return send(401, { error: "Login yoki parol noto'g'ri" }); }
      }
      const t = crypto.randomBytes(32).toString("hex");
      await Ses.insertOne({ _id: th(t), login: l, exp: new Date(Date.now() + 90 * 864e5) });
      return send(200, { token: t, login: l });
    }

    const tok = (H.authorization || "").slice(7), s = tok && await Ses.findOne({ _id: th(tok) });
    if (!s || s.exp < new Date()) return send(401, { error: "Kirish talab qilinadi" });
    if (m === "POST" && route === "logout") { await Ses.deleteOne({ _id: th(tok) }); return send(200, {}); }

    if (route === "data" && m === "GET") {
      const u = await Users.findOne({ _id: s.login }); if (!u) return send(401, { error: "Kirish talab qilinadi" });
      if ((event.queryStringParameters || {}).v === String(u.version)) return send(200, { same: true });
      return send(200, snap(u));
    }
    if (route === "data" && m === "PUT") {
      const b = body();
      if (!b || !Array.isArray(b.students) || !Array.isArray(b.payments) || !Number.isInteger(b.version) || b.students.length > 20000 || b.payments.length > 100000) return send(400, { error: "Noto'g'ri ma'lumot" });
      const st = b.students.map(cs), ids = new Set(st.map(x => x.id)), pay = b.payments.map(cp).filter(p => ids.has(p.sid) && p.amount > 0);
      const set = { students: st, payments: pay };
      if (Array.isArray(b.groups)) set.groups = b.groups.slice(0, 5000).map(g => ({ key: str(g && g.key, 200), start: DT.test(g && g.start) ? g.start : "", lessons: (Array.isArray(g && g.lessons) ? g.lessons : []).slice(0, 3000).filter(l => l && DD.test(l.date)).map(l => ({ id: num(l.id), date: l.date })) }));
      const r = await Users.updateOne({ _id: s.login, version: b.version }, { $set: set, $inc: { version: 1 } });
      if (!r.matchedCount) { const u = await Users.findOne({ _id: s.login }); return send(409, snap(u)); }
      return send(200, { version: b.version + 1 });
    }
    return send(404, { error: "Topilmadi" });
  } catch (e) { console.error(e); return send(500, { error: "Server xatosi" }); }
};
