const express = require("express");
const { ThreadsAPI } = require("threads-api");
const { HttpsProxyAgent } = require("https-proxy-agent");
const app = express();

app.use(express.json());

// ▼▼▼ プロキシ設定 ▼▼▼
const PROXY_URL = 'http://86a4c5a5d75ab064cd33__cr.jp:ae68af898d6ead3b@gw.dataimpulse.com:823';
// ▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲

const requestQueue = [];
let isProcessing = false;

// 1. ログイン確認用
app.post("/api/check", async (req, res) => {
  const { username, token, deviceId } = req.body;
  console.log(`[Login Check] ${username}`);

  try {
    const proxyAgent = new HttpsProxyAgent(PROXY_URL);
    const threadsAPI = new ThreadsAPI({
      username: username,
      token: token, 
      deviceID: deviceId,
      axiosConfig: { httpAgent: proxyAgent, httpsAgent: proxyAgent },
    });

    const userID = await threadsAPI.getUserIDfromUsername(username);
    res.json({ status: "success", message: `Cookieログイン成功！UserID: ${userID}` });

  } catch (error) {
    console.error(`[Login Check] 失敗: ${error.message}`);
    res.status(500).json({ status: "error", message: error.message });
  }
});

// 2. 予約受付
app.post("/api/enqueue", (req, res) => {
  const { username, token, text, deviceId, imageUrl } = req.body;
  requestQueue.push({ username, token, text, deviceId, imageUrl });
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
      const proxyAgent = new HttpsProxyAgent(PROXY_URL);
      
      const threadsAPI = new ThreadsAPI({
        username: task.username,
        token: task.token, 
        deviceID: task.deviceId,
        axiosConfig: { httpAgent: proxyAgent, httpsAgent: proxyAgent },
      });

      await threadsAPI.publish({ text: task.text, image: task.imageUrl });
      console.log(`✅ 投稿成功: ${task.username}`);

    } catch (error) {
      console.error(`❌ 投稿失敗 (${task.username}):`, error.message);
      
      // ★★★ エラーの正体を暴くログを追加 ★★★
      if (error.response) {
        console.log("▼▼▼ エラー詳細 (ここを教えて！) ▼▼▼");
        console.log(JSON.stringify(error.response.data, null, 2));
        console.log("▲▲▲ エラー詳細 ここまで ▲▲▲");
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
