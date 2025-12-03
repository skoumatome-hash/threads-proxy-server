const express = require("express");
const { ThreadsAPI } = require("threads-api");
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
//  ブラウザ偽装ヘッダー作成 (成功実績あり)
// ---------------------------------------------------------
function createBrowserHeaders(ua, fullCookie, csrftoken) {
  return {
    'User-Agent': ua,
    'Cookie': fullCookie,
    'x-csrftoken': csrftoken,
    'x-ig-app-id': '238260118697367', // WebブラウザのAppID
    'x-asbd-id': '129477',
    'Authority': 'www.threads.net',
    'Accept': '*/*',
    'Accept-Language': 'en-US,en;q=0.9',
    'Cache-Control': 'no-cache',
    'Origin': 'https://www.threads.net',
    'Referer': 'https://www.threads.net/',
    'Sec-Fetch-Dest': 'empty',
    'Sec-Fetch-Mode': 'cors',
    'Sec-Fetch-Site': 'same-origin',
  };
}

// 1. ログイン確認 (兼 接続テスト)
app.post("/api/check", async (req, res) => {
  const { username, fullCookie, ua, proxy } = req.body;
  console.log(`[Login Check] ${username}`);

  if (!proxy || !fullCookie) return res.status(400).json({ status: "error", message: "情報不足" });

  try {
    // 生通信でチェック (ライブラリのバグ回避)
    const formattedProxy = formatProxy(proxy);
    const proxyAgent = new HttpsProxyAgent(formattedProxy);
    const realCsrf = getCookieValue(fullCookie, "csrftoken");
    const headers = createBrowserHeaders(ua, fullCookie, realCsrf);

    const targetUrl = `https://www.threads.net/@${username}`;
    const response = await axios.get(targetUrl, {
      httpsAgent: proxyAgent,
      headers: headers,
      proxy: false,
      validateStatus: status => status < 500
    });

    if (response.status === 200) {
      res.json({ status: "success", message: "★接続OK！ (Webとして認識されました)" });
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
  // 必要な情報を全部受け取ってキューに入れる
  const { username, fullCookie, text, deviceId, imageUrl, ua, proxy } = req.body;
  requestQueue.push({ username, fullCookie, text, deviceId, imageUrl, ua, proxy });
  console.log(`[受付] ${username} を予約`);
  res.json({ status: "queued", message: "予約完了" });
  processQueue();
});

// 3. 処理ワーカー (ログイン → 即投稿)
async function processQueue() {
  if (isProcessing || requestQueue.length === 0) return;
  isProcessing = true;

  while (requestQueue.length > 0) {
    const task = requestQueue.shift();
    console.log(`\n--- 処理開始: ${task.username} ---`);

    try {
      const formattedProxy = formatProxy(task.proxy);
      const proxyAgent = new HttpsProxyAgent(formattedProxy);
      
      const sessionid = getCookieValue(task.fullCookie, "sessionid");
      const realCsrf = getCookieValue(task.fullCookie, "csrftoken");
      const realDeviceId = getCookieValue(task.fullCookie, "ig_did") || task.deviceId;

      // 1. クライアント作成
      const threadsAPI = new ThreadsAPI({
        username: task.username,
        token: sessionid,
        deviceID: realDeviceId,
        // ここでの設定は初期値として渡す
        axiosConfig: { 
          httpAgent: proxyAgent, 
          httpsAgent: proxyAgent,
        },
      });

      // ★重要: ライブラリが勝手にヘッダーを変えないよう、送信直前に「検問」で書き換える
      const browserHeaders = createBrowserHeaders(task.ua, task.fullCookie, realCsrf);
      
      threadsAPI.axios.interceptors.request.use(config => {
        // ヘッダーを強制上書き
        Object.assign(config.headers, browserHeaders);
        return config;
      });

      // 2. 「ログインした状態」で投稿を実行
      console.log("投稿リクエスト送信...");
      await threadsAPI.publish({ text: task.text, image: task.imageUrl });
      
      console.log(`✅ 投稿成功: ${task.username}`);

    } catch (error) {
      console.error(`❌ 投稿失敗 (${task.username}):`, error.message);
      if (error.response) {
        console.log(JSON.stringify(error.response.data));
      }
    }

    // 休憩 (IPローテ対策)
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
