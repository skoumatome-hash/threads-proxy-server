const express = require("express");
const { ThreadsAPI } = require("threads-api");
const { HttpsProxyAgent } = require("https-proxy-agent");
const app = express();

app.use(express.json());

const requestQueue = [];
let isProcessing = false;

// 1. 厳密なログイン確認
app.post("/api/check", async (req, res) => {
  const { username, fullCookie, deviceId, ua, proxy } = req.body;
  console.log(`[Login Check] ${username}`);

  if (!proxy || !fullCookie) {
    return res.status(400).json({ status: "error", message: "プロキシまたはCookie情報が不足しています" });
  }

  try {
    const proxyAgent = new HttpsProxyAgent(proxy);
    
    const threadsAPI = new ThreadsAPI({
      username: username,
      token: "dummy",
      deviceID: deviceId,
      axiosConfig: { 
        httpAgent: proxyAgent, 
        httpsAgent: proxyAgent,
        headers: {
          'Cookie': fullCookie,
          'User-Agent': ua
        }
      },
    });

    // ① まずユーザーIDを取得
    const userID = await threadsAPI.getUserIDfromUsername(username);
    
    // ② 【ここが追加】 実際にプロフィール情報を取得して、アクセス権があるかテストする
    // Cookieが無効、またはIPが不一致なら、ここで「403エラー」が出るはずです
    await threadsAPI.getUserProfile(userID);

    res.json({ status: "success", message: `★ログイン状態よし！ UserID: ${userID}` });

  } catch (error) {
    console.error(`[Login Check] 失敗: ${error.message}`);
    // エラー詳細があればログに出す
    if (error.response) {
      console.log(JSON.stringify(error.response.data));
      // 403 Forbidden なら明確に伝える
      if (error.response.status === 403 || error.message.includes("Login")) {
        return res.status(403).json({ status: "error", message: "【重要】Cookieが無効、またはプロキシIPが一致していません。強制ログアウトされています。" });
      }
    }
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
      const proxyAgent = new HttpsProxyAgent(task.proxy);

      const threadsAPI = new ThreadsAPI({
        username: task.username,
        token: "dummy",
        deviceID: task.deviceId,
        axiosConfig: { 
          httpAgent: proxyAgent, 
          httpsAgent: proxyAgent,
          headers: {
            'Cookie': task.fullCookie,
            'User-Agent': task.ua
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
