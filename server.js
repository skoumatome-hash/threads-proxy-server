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
  const { username, token, deviceId, csrftoken } = req.body;
  console.log(`[Login Check] ${username}`);

  try {
    const proxyAgent = new HttpsProxyAgent(PROXY_URL);
    
    // ★修正: Cookieを合体させる
    // sessionid と csrftoken を両方とも1つの文字列にする
    const cookieString = `sessionid=${token}; csrftoken=${csrftoken}`;

    const threadsAPI = new ThreadsAPI({
      username: username,
      token: token, 
      deviceID: deviceId,
      axiosConfig: { 
        httpAgent: proxyAgent, 
        httpsAgent: proxyAgent,
        headers: {
          'x-csrftoken': csrftoken,
          'Cookie': cookieString // ★ここが修正ポイント！上書きせず合体版を渡す
        }
      },
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
  const { username, token, text, deviceId, imageUrl, csrftoken } = req.body;
  requestQueue.push({ username, token, text, deviceId, imageUrl, csrftoken });
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
      
      // ★修正: ワーカー側もCookieを合体させる
      const cookieString = `sessionid=${task.token}; csrftoken=${task.csrftoken}`;

      const threadsAPI = new ThreadsAPI({
        username: task.username,
        token: task.token, 
        deviceID: task.deviceId,
        axiosConfig: { 
          httpAgent: proxyAgent, 
          httpsAgent: proxyAgent,
          headers: {
            'x-csrftoken': task.csrftoken,
            'Cookie': cookieString // ★修正ポイント
          }
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
