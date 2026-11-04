// api/ai.js — Đầu mối AI chung KetoanAI (Vercel Serverless Function)
// Key đọc từ Environment Variables phía server — KHÔNG nhúng vào HTML, KHÔNG gửi qua chat.
// Hợp đồng với app:
//   POST { "ping": true }                                  -> { ok, configured, provider }  (không gọi AI, không tốn token)
//   POST { "prompt": "...", "context": "..." }             -> { text }                      (hỏi đáp / định khoản / công văn)
//   POST { "prompt": "...", "context": "...",
//          "image": { "mime": "image/jpeg", "data": "..." } } -> { text }                 (đọc hóa đơn, data là base64)
// Nhà cung cấp tự chọn theo key có mặt: ANTHROPIC_API_KEY > OPENAI_API_KEY > GEMINI_API_KEY.
// Đổi model bằng biến AI_MODEL nếu muốn.

const SYSTEM_PROMPT = `Bạn là trợ lý kế toán — thuế Việt Nam của KetoanAI.
- Trả lời theo chế độ kế toán TT 200/2014 và TT 133/2016, luật thuế hiện hành.
- Luôn trích dẫn số hiệu văn bản khi nêu căn cứ; không chắc thì nói rõ là chưa chắc, không bịa số liệu, ngưỡng hay số hiệu.
- Số tiền, thuế, lương, khấu hao: chỉ diễn giải số do app cung cấp trong ngữ cảnh, không tự nhẩm lại.
- Nguyên tắc: AI chỉ chuẩn bị và gợi ý — người có thẩm quyền mới ký và nộp hồ sơ.`;

function pickProvider() {
  if (process.env.ANTHROPIC_API_KEY) return { name: "anthropic", key: process.env.ANTHROPIC_API_KEY, model: process.env.AI_MODEL || "claude-sonnet-4-5" };
  if (process.env.OPENAI_API_KEY) return { name: "openai", key: process.env.OPENAI_API_KEY, model: process.env.AI_MODEL || "gpt-4o" };
  if (process.env.GEMINI_API_KEY || process.env.AI_KEY) return { name: "google", key: process.env.GEMINI_API_KEY || process.env.AI_KEY, model: process.env.AI_MODEL || "gemini-2.0-flash" };
  return null;
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
  const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});
  const prov = pickProvider();
  if (body.ping) return res.status(200).json({ ok: true, configured: !!prov, provider: prov ? prov.name : null });
  if (!prov) return res.status(500).json({ error: "Server chưa cấu hình key AI (ANTHROPIC_API_KEY / OPENAI_API_KEY / GEMINI_API_KEY)" });

  const prompt = String(body.prompt || "").slice(0, 8000);       // giới hạn độ dài đầu vào
  const context = String(body.context || "").slice(0, 12000);   // ngữ cảnh do app tổng hợp
  if (!prompt) return res.status(400).json({ error: "Thiếu prompt" });
  const image = body.image && body.image.data ? body.image : null;
  if (image && String(image.data).length > 14000000) return res.status(413).json({ error: "File quá lớn" });
  // TODO khi mở công khai: thêm rate-limit theo IP / ngày ở đây, trước khi gọi nhà cung cấp.

  const system = SYSTEM_PROMPT + "\n\nNGỮ CẢNH TỪ APP:\n" + context;
  let r, j;
  if (prov.name === "anthropic") {
    const content = [];
    if (image) content.push(image.mime === "application/pdf"
      ? { type: "document", source: { type: "base64", media_type: "application/pdf", data: image.data } }
      : { type: "image", source: { type: "base64", media_type: image.mime, data: image.data } });
    content.push({ type: "text", text: prompt });
    r = await fetch("https://api.anthropic.com/v1/messages", { method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": prov.key, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model: prov.model, max_tokens: 1500, system, messages: [{ role: "user", content }] }) });
    j = await r.json();
    if (!r.ok) return res.status(r.status).json({ error: (j.error && j.error.message) || "AI provider error" });
    return res.status(200).json({ text: (j.content || []).map(c => c.text || "").join("") });
  }
  if (prov.name === "google") {
    const parts = [];
    if (image) parts.push({ inlineData: { mimeType: image.mime, data: image.data } });
    parts.push({ text: prompt });
    r = await fetch("https://generativelanguage.googleapis.com/v1beta/models/" + prov.model + ":generateContent", { method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": prov.key },
      body: JSON.stringify({ systemInstruction: { parts: [{ text: system }] }, contents: [{ parts }], generationConfig: { maxOutputTokens: 1500 } }) });
    j = await r.json();
    if (!r.ok) return res.status(r.status).json({ error: (j.error && j.error.message) || "AI provider error" });
    const p2 = (j.candidates && j.candidates[0] && j.candidates[0].content && j.candidates[0].content.parts) || [];
    return res.status(200).json({ text: p2.map(x => x.text || "").join("") });
  }
  // openai (tương thích OpenAI) — đường này chỉ nhận ảnh, không nhận PDF
  if (image && image.mime === "application/pdf") return res.status(400).json({ error: "OpenAI không nhận PDF qua đầu mối — dùng ảnh, hoặc cấu hình Claude / Gemini" });
  const userContent = image
    ? [{ type: "image_url", image_url: { url: "data:" + image.mime + ";base64," + image.data } }, { type: "text", text: prompt }]
    : prompt;
  r = await fetch("https://api.openai.com/v1/chat/completions", { method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": "Bearer " + prov.key },
    body: JSON.stringify({ model: prov.model, max_tokens: 1500, messages: [{ role: "system", content: system }, { role: "user", content: userContent }] }) });
  j = await r.json();
  if (!r.ok) return res.status(r.status).json({ error: (j.error && j.error.message) || "AI provider error" });
  return res.status(200).json({ text: (j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content) || "" });
}
