const express = require("express");
const { HttpsProxyAgent } = require("https-proxy-agent");
const axios = require("axios");
const app = express();

app.use(express.json());

const requestQueue = [];
let isProcessing = false;

// ---------------------------------------------------------
//  Cookie値の抽出
// ---------------------------------------------------------
function getCookieValue(cookieString, key) {
  if (!cookieString) return null;
  const match = cookieString.match(new RegExp('(^|;\\s*)' + key + '=([^;]*)'));
  if (match && match[2]) return decodeURIComponent(match[2]);
  return null;
}

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
//  WEBブラウザと同じヘッダーを作る
// ---------------------------------------------------------
function createWebHeaders(ua, fullCookie, csrftoken, lsd = null) {
  const headers = {
    'User-Agent': ua,
    'Cookie': fullCookie,
    'x-csrftoken': csrftoken,
    'x-ig-app-id': '238260118697367', // WEB版のAppID
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
  
  if (lsd) {
    headers['x-fb-lsd'] = lsd;
  }
  
  return headers;
}

// ---------------------------------------------------------
//  LSDトークンをページからスクレイピングする
// ---------------------------------------------------------
async function fetchLSD(username, agent, headers) {
  try {
    const response = await axios.get(`https://www.threads.net/@${username}`, {
      httpsAgent: agent,
      headers: headers,
      proxy: false
    });
    
    // HTMLの中から "LSD", [], {"token": "..."} を探す
    const match = response.data.match(/"LSD",\[\],{"token":"(.*?)"}/);
    if (match && match[1]) {
      return match[1];
    }
  } catch (e) {
    console.error("LSD取得エラー:", e.message);
  }
  return null;
}

// 1. ログイン確認 (兼 接続テスト)
app.post("/api/check", async (req, res) => {
  const { username, fullCookie, ua, proxy } = req.body;
  console.log(`[Login Check] ${username}`);

  try {
    const formattedProxy = formatProxy(proxy);
    const proxyAgent = new HttpsProxyAgent(formattedProxy);
    const realCsrf = getCookieValue(fullCookie, "csrftoken");
    
    // まずLSDを取得できるかテスト
    const headers = createWebHeaders(ua, fullCookie, realCsrf);
    const lsd = await fetchLSD(username, proxyAgent, headers);

    if (lsd) {
      res.json({ status: "success", message: `★完全接続OK！ (Web Token: ${lsd.substring(0,5)}...)` });
    } else {
      // LSDが取れない＝ログインページに飛ばされている可能性大
      res.status(403).json({ status: "error", message: "ログインできませんでした（Webページ読み込み失敗）" });
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

// 3. 処理ワーカー (脱ライブラリ・完全Web版)
async function processQueue() {
  if (isProcessing || requestQueue.length === 0) return;
  isProcessing = true;

  while (requestQueue.length > 0) {
    const task = requestQueue.shift();
    console.log(`\n--- 処理開始: ${task.username} ---`);

    try {
      const formattedProxy = formatProxy(task.proxy);
      const proxyAgent = new HttpsProxyAgent(formattedProxy);
      const realCsrf = getCookieValue(task.fullCookie, "csrftoken");
      const userID = getCookieValue(task.fullCookie, "ds_user_id");

      // 1. まずLSDトークンを取得
      let headers = createWebHeaders(task.ua, task.fullCookie, realCsrf);
      const lsd = await fetchLSD(task.username, proxyAgent, headers);
      
      if (!lsd) throw new Error("LSDトークンの取得に失敗しました");

      // 2. 投稿用のヘッダーに更新
      headers = createWebHeaders(task.ua, task.fullCookie, realCsrf, lsd);

      // 3. 投稿ペイロード作成 (GraphQL)
      const postPayload = new URLSearchParams();
      postPayload.append('lsd', lsd);
      postPayload.append('variables', JSON.stringify({
        userID: userID,
        text: task.text,
        // 画像がある場合は添付処理が必要ですが、まずはテキスト投稿を成功させます
        // internal_badge_payload: null,
        // link_attachment_url: null
      }));
      postPayload.append('doc_id', '23980155133315596'); // Web版のCreate Post ID (汎用)

      // 4. 投稿実行
      console.log("投稿リクエスト送信...");
      const response = await axios.post("https://www.threads.net/api/graphql", postPayload, {
        httpsAgent: proxyAgent,
        headers: headers,
        proxy: false
      });

      // 成功判定
      if (response.data && response.data.data) {
        console.log(`✅ 投稿成功: ${task.username}`);
      } else {
        console.error("投稿失敗レスポンス:", JSON.stringify(response.data));
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
