const express = require("express");
const { ThreadsAPI } = require("threads-api");
const { HttpsProxyAgent } = require("https-proxy-agent");
const axios = require("axios");
const app = express();

app.use(express.json());

const requestQueue = [];
let isProcessing = false;

// ---------------------------------------------------------
//  Cookie文字列から値を抜き出す関数
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

// 1. ログイン確認 (ブラウザ完全偽装版)
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

    // ブラウザになりきるためのヘッダー
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
      'Pragma': 'no-cache',
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
      validateStatus: function (status) {
        return status >= 200 && status < 500;
      }
    });

    console.log(`Response Status: ${response.status}`);

    if (response.status === 200) {
      if (response.data.includes(username)) {
        res.json({ status: "success", message: "★ログイン確認よし！ (Profile Page 200 OK)" });
      } else {
        res.json({ status: "success", message: "★通信成功 (Status 200)" });
      }
    } else if (response.status === 404) {
      res.status(404).json({ status: "error", message: "ページが見つかりません (404)" });
    } else {
      res.status(response.status).json({ status: "error", message: `ステータス異常: ${response.status}` });
    }

  } catch (error) {
    console.error(`[Login Check] 通信失敗: ${error.message}`);
    
    if (error.response) {
      console.log(`Status: ${error.response.status}`);
      const status = error.response.status;
      
      // ★ここがエラーの原因だった箇所を修正しました★
      if (status === 403 || status === 401) {
         return res.status(403).json({ status: "error", message: "拒否されました(403): プロキシまたはCookieが無効です" });
      }
      if (status === 302) {
         return res.status(302).json({ status: "error", message: "リダイレクト(302): ログイン画面に飛ばされました" });
      }
    }
    res.status(500).json({ status: "error", message: `通信エラー: ${error.message}` });
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
      
      const sessionid = getCookieValue(task.fullCookie, "sessionid");
      const realCsrf = getCookieValue(task.fullCookie, "csrftoken");
      const realDeviceId = getCookieValue(task.fullCookie, "ig_did") || task.deviceId;

      const threadsAPI = new ThreadsAPI({
        username: task.username,
        token: sessionid,
        deviceID: realDeviceId,
        axiosConfig: { 
          httpAgent: proxyAgent, 
          httpsAgent: proxyAgent,
          headers: {
            'User-Agent': task.ua,
            'Cookie': task.fullCookie,
            'x-csrftoken': realCsrf
          }
        },
      });

      await threadsAPI.publish({ text: task.text, image: task.imageUrl });
      console.log(`✅ 投稿成功: ${task.username}`);

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
