const express = require("express");
const { HttpsProxyAgent } = require("https-proxy-agent");
const axios = require("axios");
const crypto = require("crypto");
const app = express();

app.use(express.json());

const requestQueue = [];
let isProcessing = false;

// ---------------------------------------------------------
//  Cookieヘルパー
// ---------------------------------------------------------
function parseCookieInput(input) {
  let sessionid = null, userID = null, deviceId = null, csrftoken = null;
  let headerString = "";
  if (!input) return { sessionid, userID, deviceId, headerString };
  
  const trimmed = input.trim();

  if (trimmed.startsWith("[") || trimmed.startsWith("{")) {
    try {
      const cookies = JSON.parse(trimmed);
      const parts = [];
      if (Array.isArray(cookies)) {
        cookies.forEach(c => {
          if (c.name === "sessionid") sessionid = decodeURIComponent(c.value);
          if (c.name === "ds_user_id") userID = c.value;
          if (c.name === "ig_did") deviceId = c.value;
          if (c.name === "csrftoken") csrftoken = c.value;
          parts.push(`${c.name}=${c.value}`);
        });
        headerString = parts.join("; ");
      }
    } catch (e) { console.error(e); }
  } else {
    headerString = trimmed;
    const sessMatch = trimmed.match(/(^|;\s*)sessionid=([^;]*)/);
    if (sessMatch) sessionid = decodeURIComponent(sessMatch[1]);
    const userMatch = trimmed.match(/(^|;\s*)ds_user_id=([^;]*)/);
    if (userMatch) userID = userMatch[1];
    const csrfMatch = trimmed.match(/(^|;\s*)csrftoken=([^;]*)/);
    if (csrfMatch) csrftoken = csrfMatch[2];
  }
  return { sessionid, userID, deviceId, csrftoken, headerString };
}

// Cookie更新用
function mergeCookies(oldCookieString, setCookieHeader) {
  if (!setCookieHeader || !Array.isArray(setCookieHeader)) return oldCookieString;
  const cookieMap = new Map();
  oldCookieString.split(';').forEach(c => {
    const [key, ...v] = c.trim().split('=');
    if (key) cookieMap.set(key, v.join('='));
  });
  setCookieHeader.forEach(c => {
    const [keyVal] = c.split(';');
    const [key, ...v] = keyVal.trim().split('=');
    if (key) cookieMap.set(key, v.join('='));
  });
  const parts = [];
  for (const [key, value] of cookieMap) parts.push(`${key}=${value}`);
  return parts.join('; ');
}

function extractValueFromCookieString(cookieString, key) {
  const match = cookieString.match(new RegExp('(^|;\\s*)' + key + '=([^;]*)'));
  return match ? match[2] : null;
}

function formatProxy(proxyStr) {
  if (!proxyStr) return null;
  if (proxyStr.startsWith("http")) return proxyStr;
  const parts = proxyStr.split(':');
  if (parts.length === 4) {
    const [host, port, user, pass] = parts;
    return `http://${user}:${pass}@${host}:${port}`;
  }
  return proxyStr;
}

// ★修正: AJAXヘッダーを復活させた完全版
function createWebHeaders(ua, fullCookie, csrftoken, lsd = null) {
  const headers = {
    'User-Agent': ua,
    'Cookie': fullCookie,
    'x-csrftoken': csrftoken,
    'x-ig-app-id': '238260118697367',
    'x-asbd-id': '129477',
    'Authority': 'www.threads.net',
    'Accept': '*/*',
    'Accept-Language': 'en-US,en;q=0.9',
    'Cache-Control': 'no-cache',
    'Content-Type': 'application/x-www-form-urlencoded',
    'Origin': 'https://www.threads.net',
    'Referer': 'https://www.threads.net/',
    'Sec-Fetch-Dest': 'empty',
    'Sec-Fetch-Mode': 'cors',
    'Sec-Fetch-Site': 'same-origin',
    'X-Requested-With': 'XMLHttpRequest', // ★これがナイトHTMLが返ってくる！
    'X-Instagram-Ajax': '1'
  };
  
  if (lsd) headers['x-fb-lsd'] = lsd;
  return headers;
}

// 1. ログイン確認
app.post("/api/check", async (req, res) => {
  const { username, fullCookie, ua, proxy } = req.body;
  console.log(`[Login Check] ${username}`);
  if (!proxy || !fullCookie) return res.status(400).json({ status: "error", message: "情報不足" });

  try {
    const formattedProxy = formatProxy(proxy);
    const proxyAgent = new HttpsProxyAgent(formattedProxy);
    const { userID, headerString, csrftoken } = parseCookieInput(fullCookie);
    
    // チェック時はGETなので最低限のヘッダーでOK
    const headers = createWebHeaders(ua, headerString, csrftoken);
    
    const response = await axios.get(`https://www.threads.net/@${username}`, {
      httpsAgent: proxyAgent,
      headers: headers,
      proxy: false,
      validateStatus: s => s < 500
    });

    if (response.status === 200) {
      res.json({ status: "success", message: `★接続OK (ID: ${userID})` });
    } else {
      res.status(response.status).json({ status: "error", message: `ステータス異常: ${response.status}` });
    }
  } catch (error) {
    console.error(`[Login Check] エラー: ${error.message}`);
    res.status(500).json({ status: "error", message: error.message });
  }
});

// 2. 予約受付
app.post("/api/enqueue", (req, res) => {
  const { username, fullCookie, text, deviceId, imageUrl, ua, proxy } = req.body;
  requestQueue.push({ username, fullCookie, text, deviceId, imageUrl, ua, proxy });
  console.log(`[受付] ${username} を予約`);
  res.json({ status: "queued", message: "予約完了" });
  processQueue();
});

// 3. 処理ワーカー
async function processQueue() {
  if (isProcessing || requestQueue.length === 0) return;
  isProcessing = true;

  while (requestQueue.length > 0) {
    const task = requestQueue.shift();
    console.log(`\n--- 処理開始: ${task.username} ---`);

    try {
      const formattedProxy = formatProxy(task.proxy);
      const proxyAgent = new HttpsProxyAgent(formattedProxy);
      
      const { userID, headerString: initialCookie, csrftoken: initialCsrf } = parseCookieInput(task.fullCookie);
      
      // 1. LSD取得
      console.log("LSD取得中...");
      let headers = createWebHeaders(task.ua, initialCookie, initialCsrf);
      const pageRes = await axios.get(`https://www.threads.net/@${task.username}`, {
        httpsAgent: proxyAgent,
        headers: headers,
        proxy: false
      });

      const lsdMatch = pageRes.data.match(/"LSD",\[\],{"token":"(.*?)"}/);
      const lsd = lsdMatch ? lsdMatch[1] : null;
      
      if (!lsd) throw new Error("LSD取得失敗");
      console.log(`LSD: ${lsd}`);

      // Cookie更新 (継承)
      const updatedCookieString = mergeCookies(initialCookie, pageRes.headers['set-cookie']);
      const updatedCsrf = extractValueFromCookieString(updatedCookieString, "csrftoken") || initialCsrf;

      // 2. 投稿 (GraphQL) - ★ここにAJAXヘッダーが入る！
      const postHeaders = createWebHeaders(task.ua, updatedCookieString, updatedCsrf, lsd);
      postHeaders['x-fb-friendly-name'] = 'BarcelonaCreatePostMutation';

      const postPayload = new URLSearchParams();
      postPayload.append('lsd', lsd);
      postPayload.append('variables', JSON.stringify({
        userID: userID,
        text: task.text,
        publicationOpt: "any_user",
        attachmentUtils: null,
        client_mutation_id: crypto.randomUUID()
      }));
      postPayload.append('doc_id', '23980155133315596');

      console.log("投稿リクエスト送信...");
      const postRes = await axios.post("https://www.threads.net/api/graphql", postPayload, {
        httpsAgent: proxyAgent,
        headers: postHeaders,
        proxy: false
      });

      // 成功判定
      if (postRes.data?.data?.xfb_create_threads_post_content) {
         console.log(`✅ 投稿成功: ${task.username}`);
      } else {
         console.log("投稿失敗(レスポンス):", JSON.stringify(postRes.data));
      }

    } catch (error) {
      console.error(`❌ 投稿失敗 (${task.username}):`, error.message);
      if (error.response) {
         console.log("Error Data:", JSON.stringify(error.response.data).substring(0, 300));
      }
    }

    if (requestQueue.length > 0) {
      console.log("☕ 休憩中 (25秒)...");
      await new Promise((resolve) => setTimeout(resolve, 25000));
    }
  }
  isProcessing = false;
}

const listener = app.listen(process.env.PORT, () => {
  console.log("Server started");
});
