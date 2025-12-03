const express = require("express");
const { ThreadsAPI } = require("threads-api");
const { HttpsProxyAgent } = require("https-proxy-agent");
const axios = require("axios");
const app = express();

app.use(express.json());

const requestQueue = [];
let isProcessing = false;

// Cookieから値を抜く
function getCookieValue(cookieString, key) {
  if (!cookieString) return null;
  const match = cookieString.match(new RegExp('(^|;\\s*)' + key + '=([^;]*)'));
  if (match && match[2]) return decodeURIComponent(match[2]);
  return null;
}

// プロキシ形式変換 (host:port:user:pass -> http://...)
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

// 1. ログイン確認
app.post("/api/check", async (req, res) => {
  const { username, fullCookie, ua, proxy } = req.body;
  console.log(`[Login Check] ${username}`);

  if (!proxy || !fullCookie) {
    return res.status(400).json({ status: "error", message: "情報不足" });
  }

  try {
    const formattedProxy = formatProxy(proxy);
    const proxyAgent = new HttpsProxyAgent(formattedProxy);
    const realCsrf = getCookieValue(fullCookie, "csrftoken");

    // 成功したヘッダー構成
    const headers = {
      'User-Agent': ua,
      'Cookie': fullCookie,
      'x-csrftoken': realCsrf,
      'x-ig-app-id': '238260118697367',
      'x-asbd-id': '129477',
      'Authority': 'www.threads.net',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9',
      'Cache-Control': 'no-cache',
      'Sec-Fetch-Dest': 'document',
      'Sec-Fetch-Mode': 'navigate',
      'Sec-Fetch-Site': 'none',
      'Sec-Fetch-User': '?1',
      'Upgrade-Insecure-Requests': '1'
    };

    const targetUrl = `https://www.threads.net/@${username}`;

    const response = await axios.get(targetUrl, {
      httpsAgent: proxyAgent,
      headers: headers,
      proxy: false,
      validateStatus: status => status < 500
    });

    console.log(`Check Response: ${response.status}`);

    if (response.status === 200) {
      res.json({ status: "success", message: "★ログイン確認よし！ (Profile Page 200 OK)" });
    } else if (response.status === 404) {
      res.status(404).json({ status: "error", message: "ページが見つかりません (404)" });
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
  console.log(`[受付] ${username}`);
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
      // ★修正: ここでプロキシ変換を忘れていたのを修正！
      const formattedProxy = formatProxy(task.proxy);
      const proxyAgent = new HttpsProxyAgent(formattedProxy);
      
      const sessionid = getCookieValue(task.fullCookie, "sessionid");
      const realCsrf = getCookieValue(task.fullCookie, "csrftoken");
      const realDeviceId = getCookieValue(task.fullCookie, "ig_did") || task.deviceId;

      // ★修正: 成功したヘッダーをここにも適用
      // (API呼び出し用なので一部調整していますが、基本構成は同じです)
      const headers = {
        'User-Agent': task.ua,
        'Cookie': task.fullCookie,
        'x-csrftoken': realCsrf,
        'x-ig-app-id': '238260118697367',
        'x-asbd-id': '129477',
        'Origin': 'https://www.threads.net',
        'Referer': 'https://www.threads.net/',
        'Sec-Fetch-Dest': 'empty',
        'Sec-Fetch-Mode': 'cors',
        'Sec-Fetch-Site': 'same-origin',
      };

      const threadsAPI = new ThreadsAPI({
        username: task.username,
        token: sessionid,
        deviceID: realDeviceId,
        axiosConfig: { 
          httpAgent: proxyAgent, 
          httpsAgent: proxyAgent,
          headers: headers // ★最強ヘッダー注入
        },
      });

      await threadsAPI.publish({ text: task.text, image: task.imageUrl });
      console.log(`✅ 投稿成功: ${task.username}`);

    } catch (error) {
      console.error(`❌ 投稿失敗 (${task.username}):`, error.message);
      if (error.response) {
        console.log(JSON.stringify(error.response.data));
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
