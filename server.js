const express = require("express");
const { HttpsProxyAgent } = require("https-proxy-agent");
const axios = require("axios");
const app = express();

app.use(express.json());

const requestQueue = [];
let isProcessing = false;

// ---------------------------------------------------------
//  プロキシ形式変換
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
//  Cookieを「再構築」する関数 (JSON -> String)
// ---------------------------------------------------------
function reconstructCookie(input) {
  let cookieString = "";
  let sessionid = "";
  let userID = "";
  let csrftoken = "";

  if (!input) return { cookieString, sessionid, userID, csrftoken };

  const trimmed = input.trim();

  // JSONの場合
  if (trimmed.startsWith("[") || trimmed.startsWith("{")) {
    try {
      const cookies = JSON.parse(trimmed);
      const parts = [];
      
      if (Array.isArray(cookies)) {
        cookies.forEach(c => {
          // 必要な値を確保
          if (c.name === "sessionid") sessionid = decodeURIComponent(c.value);
          if (c.name === "ds_user_id") userID = c.value;
          if (c.name === "csrftoken") csrftoken = c.value;

          // 全てのCookieを "key=value" にして追加
          // 値はエンコードされたまま使うのが安全
          parts.push(`${c.name}=${c.value}`);
        });
      }
      cookieString = parts.join("; ");

    } catch (e) {
      console.error("JSON解析失敗:", e.message);
    }
  } else {
    // すでに文字列の場合
    cookieString = trimmed;
    const sessMatch = trimmed.match(/sessionid=([^;]+)/);
    if (sessMatch) sessionid = decodeURIComponent(sessMatch[1]);
    
    const userMatch = trimmed.match(/ds_user_id=([^;]+)/);
    if (userMatch) userID = userMatch[1];

    const csrfMatch = trimmed.match(/csrftoken=([^;]+)/);
    if (csrfMatch) csrftoken = csrfMatch[1];
  }

  return { cookieString, sessionid, userID, csrftoken };
}


// ---------------------------------------------------------
//  WEBブラウザ用ヘッダー生成
// ---------------------------------------------------------
function createWebHeaders(ua, cookieString, csrftoken, lsd = null) {
  const headers = {
    'User-Agent': ua,
    'Cookie': cookieString,
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
  };
  
  if (lsd) headers['x-fb-lsd'] = lsd;
  
  return headers;
}

// LSD取得
async function fetchLsdToken(username, agent, headers) {
  try {
    const response = await axios.get(`https://www.threads.net/@${username}`, {
      httpsAgent: agent,
      headers: headers,
      proxy: false,
      validateStatus: s => s < 500
    });
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
    
    // ★Cookie再構築
    const { cookieString, userID, csrftoken } = reconstructCookie(fullCookie);

    if (!userID) return res.status(400).json({ status: "error", message: "UserIDがCookieにありません" });

    // Webとしてアクセス
    const headers = createWebHeaders(ua, cookieString, csrftoken);
    
    // ログイン確認のためにプロフィールへ
    const targetUrl = `https://www.threads.net/@${username}`;
    const response = await axios.get(targetUrl, {
      httpsAgent: proxyAgent,
      headers: headers,
      proxy: false,
      validateStatus: s => s < 500
    });

    if (response.status === 200) {
      // HTML内に「ログイン」ボタンがあるかチェック（あれば失敗）
      if (response.data.includes('class="x1i10hfl x1qjc9v5')) { // ログインボタンの特徴的なクラス
         // 怪しいが、200なので一応成功として返す（投稿で白黒つく）
         res.json({ status: "success", message: `★接続成功 (ID: ${userID}) ※投稿を試してください` });
      } else {
         res.json({ status: "success", message: `★完全ログインOK (ID: ${userID})` });
      }
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
      
      // ★Cookie再構築
      const { cookieString, userID, csrftoken } = reconstructCookie(task.fullCookie);

      // 1. LSD取得
      console.log("LSDトークン取得中...");
      let headers = createWebHeaders(task.ua, cookieString, csrftoken);
      const lsd = await fetchLsdToken(task.username, proxyAgent, headers);
      
      if (!lsd) {
        console.log("LSD取得失敗。ログインページに飛ばされた可能性があります。");
        throw new Error("LSDトークン取得エラー");
      }
      console.log(`LSD: ${lsd}`);

      // 2. 投稿 (GraphQL)
      headers = createWebHeaders(task.ua, cookieString, csrftoken, lsd);
      headers['x-fb-friendly-name'] = 'BarcelonaCreatePostMutation';

      const postPayload = new URLSearchParams();
      postPayload.append('lsd', lsd);
      postPayload.append('variables', JSON.stringify({
        userID: userID,
        text: task.text,
        publicationOpt: "any_user",
        attachmentUtils: null
      }));
      postPayload.append('doc_id', '23980155133315596');

      console.log("投稿リクエスト送信(GraphQL)...");
      const response = await axios.post("https://www.threads.net/api/graphql", postPayload, {
        httpsAgent: proxyAgent,
        headers: headers,
        proxy: false
      });

      // レスポンス解析
      if (response.data.data && response.data.data.xfb_create_threads_post_content) {
         console.log(`✅ 投稿成功: ${task.username}`);
      } else if (response.data.errors) {
         console.error("GraphQL Errors:", JSON.stringify(response.data.errors));
      } else {
         // HTMLが返ってきた場合などはここに来る
         console.log("不明なレスポンス (ログイン切れの可能性):", response.data.substring(0, 100));
      }

    } catch (error) {
      console.error(`❌ 投稿失敗 (${task.username}):`, error.message);
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
