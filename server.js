const express = require("express");
const { ThreadsAPI } = require("threads-api");
const { HttpsProxyAgent } = require("https-proxy-agent");
const axios = require("axios"); // 直接通信用
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

// 1. ログイン確認 (生通信版)
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

    // ★修正: ライブラリを使わず、直接axiosで叩く
    // Threadsの「自分自身」の情報を取得するAPI
    const response = await axios.get("https://www.threads.net/api/v1/users/me", {
      httpsAgent: proxyAgent,
      headers: {
        'User-Agent': ua,
        'Cookie': fullCookie,
        'x-csrftoken': realCsrf,
        'x-ig-app-id': '238260118697367', // ThreadsのAppID
        'x-asbd-id': '129477'
      }
    });

    // 成功すればここにデータが入る
    console.log("Response Status:", response.status);
    // console.log("Data:", JSON.stringify(response.data)); 

    if (response.status === 200) {
      res.json({ status: "success", message: `★通信成功！ Status: ${response.status}` });
    } else {
      res.json({ status: "error", message: `ステータス異常: ${response.status}` });
    }

  } catch (error) {
    console.error(`[Login Check] 通信失敗: ${error.message}`);
    
    // エラーレスポンスの詳細を暴く
    if (error.response) {
      console.log(`Status: ${error.response.status}`);
      console.log(`Body: ${JSON.stringify(error.response.data)}`);
      
      const status = error.response.status;
      const body = JSON.stringify(error.response.data);

      if (status === 403 || status === 401) {
         return res.status(403).json({ status: "error", message: `拒否されました(${status}): ログインが無効です。\n${body.substring(0, 100)}` });
      }
      if (status === 302) {
         return res.status(302).json({ status: "error", message: "リダイレクトされました(302): ログイン画面に飛ばされています。" });
      }
    }
    res.status(500).json({ status: "error", message: `通信エラー: ${error.message}` });
  }
});

// 2. 予約受付 (変更なし)
app.post("/api/enqueue", (req, res) => {
  const { username, fullCookie, text, deviceId, imageUrl, ua, proxy } = req.body;
  requestQueue.push({ username, fullCookie, text, deviceId, imageUrl, ua, proxy });
  console.log(`[受付] ${username}`);
  res.json({ status: "queued", message: "予約完了" });
  processQueue();
});

// 3. 処理ワーカー (変更なし)
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

      const threadsAPI = new ThreadsAPI({
        username: task.username,
        token: sessionid || "dummy",
        deviceID: task.deviceId,
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
