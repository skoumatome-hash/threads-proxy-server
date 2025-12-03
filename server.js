const express = require("express");
const { HttpsProxyAgent } = require("https-proxy-agent");
const axios = require("axios");
const app = express();

app.use(express.json());

const requestQueue = [];
let isProcessing = false;

// ---------------------------------------------------------
//  Cookie解析
// ---------------------------------------------------------
function parseCookieInput(input) {
  let sessionid = null;
  let userID = null;
  let deviceId = null;
  let csrftoken = null;
  let headerString = "";

  if (!input) return { sessionid, userID, deviceId, headerString };

  const trimmed = input.trim();

  if (trimmed.startsWith("[") || trimmed.startsWith("{")) {
    try {
      const cookies = JSON.parse(trimmed);
      const cookieParts = [];
      if (Array.isArray(cookies)) {
        cookies.forEach(c => {
          if (c.name === "sessionid") sessionid = decodeURIComponent(c.value);
          if (c.name === "ds_user_id") userID = c.value;
          if (c.name === "ig_did") deviceId = c.value;
          if (c.name === "csrftoken") csrftoken = c.value;
          cookieParts.push(`${c.name}=${c.value}`);
        });
        headerString = cookieParts.join("; ");
      }
    } catch (e) { console.error(e); }
  } else {
    headerString = trimmed;
    const sessionMatch = trimmed.match(/(^|;\s*)sessionid=([^;]*)/);
    if (sessionMatch) sessionid = decodeURIComponent(sessionMatch[2]);
    const userMatch = trimmed.match(/(^|;\s*)ds_user_id=([^;]*)/);
    if (userMatch) userID = userMatch[2];
    const csrfMatch = trimmed.match(/(^|;\s*)csrftoken=([^;]*)/);
    if (csrfMatch) csrftoken = csrfMatch[2];
  }
  return { sessionid, userID, deviceId, csrftoken, headerString };
}

// ---------------------------------------------------------
//  プロキシ変換
// ---------------------------------------------------------
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

// ---------------------------------------------------------
//  WEB用ヘッダー生成 (AppIDはWeb用のものに固定)
// ---------------------------------------------------------
function createWebHeaders(ua, fullCookie, csrftoken) {
  return {
    'User-Agent': ua,
    'Cookie': fullCookie,
    'x-csrftoken': csrftoken,
    'x-ig-app-id': '238260118697367', // ★Web版のAppID (超重要)
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
  };
}

// ---------------------------------------------------------
//  LSD取得関数 (Webページからスクレイピング)
// ---------------------------------------------------------
async function fetchLsdToken(username, agent, headers) {
  try {
    const response = await axios.get(`https://www.threads.net/@${username}`, {
      httpsAgent: agent,
      headers: headers,
      proxy: false
    });
    // LSDトークンを探す正規表現
    const match = response.data.match(/"LSD",\[\],{"token":"(.*?)"}/);
    return match ? match[1] : null;
  } catch (e) {
    console.error("LSD取得失敗:", e.message);
    return null;
  }
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

    if (!userID) return res.status(400).json({ status: "error", message: "UserIDが特定できません" });

    // Webとしてアクセス
    const headers = createWebHeaders(ua, headerString, csrftoken);
    
    // 単純なGETリクエストでセッション確認
    const targetUrl = `https://www.threads.net/@${username}`;
    const response = await axios.get(targetUrl, {
      httpsAgent: proxyAgent,
      headers: headers,
      proxy: false,
      validateStatus: s => s < 500
    });

    if (response.status === 200) {
      res.json({ status: "success", message: `★WEB接続成功！ (ID: ${userID})` });
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

// 3. 処理ワーカー (GraphQL Web投稿)
async function processQueue() {
  if (isProcessing || requestQueue.length === 0) return;
  isProcessing = true;

  while (requestQueue.length > 0) {
    const task = requestQueue.shift();
    console.log(`\n--- 処理開始: ${task.username} ---`);

    try {
      const formattedProxy = formatProxy(task.proxy);
      const proxyAgent = new HttpsProxyAgent(formattedProxy);
      const { userID, headerString, csrftoken } = parseCookieInput(task.fullCookie);

      // 1. LSDトークンを取得
      console.log("LSDトークン取得中...");
      let headers = createWebHeaders(task.ua, headerString, csrftoken);
      const lsd = await fetchLsdToken(task.username, proxyAgent, headers);
      
      if (!lsd) throw new Error("LSDトークンが見つかりません(ログイン無効の可能性)");
      console.log(`LSD: ${lsd}`);

      // 2. 投稿リクエスト作成 (GraphQL)
      // ヘッダーにLSDを追加
      headers['x-fb-lsd'] = lsd;
      headers['x-fb-friendly-name'] = 'BarcelonaCreatePostMutation';

      const postPayload = new URLSearchParams();
      postPayload.append('lsd', lsd);
      postPayload.append('variables', JSON.stringify({
        userID: userID,
        text: task.text,
        publicationOpt: "any_user",
        attachmentUtils: null
      }));
      postPayload.append('doc_id', '23980155133315596'); // Web版投稿用ID

      // 3. 実行
      console.log("投稿リクエスト送信(GraphQL)...");
      const response = await axios.post("https://www.threads.net/api/graphql", postPayload, {
        httpsAgent: proxyAgent,
        headers: headers,
        proxy: false
      });

      // レスポンスチェック
      if (response.data && response.data.data && response.data.data.xfb_create_threads_post_content) {
         console.log(`✅ 投稿成功: ${task.username}`);
      } else if (response.data.errors) {
         console.error("GraphQL Errors:", JSON.stringify(response.data.errors));
      } else {
         console.log("不明なレスポンス:", JSON.stringify(response.data));
      }

    } catch (error) {
      console.error(`❌ 投稿失敗 (${task.username}):`, error.message);
      if (error.response) console.log(JSON.stringify(error.response.data));
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
