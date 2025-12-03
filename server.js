const express = require("express");
const { ThreadsAPI } = require("threads-api");
const { HttpsProxyAgent } = require("https-proxy-agent");
const app = express();

app.use(express.json());

// ★固定のプロキシ設定は削除しました（GASから受け取るため）

const requestQueue = [];
let isProcessing = false;

// 1. ログイン確認（本当のログインチェックを行うように修正）
app.post("/api/check", async (req, res) => {
  const { username, token, deviceId, csrftoken, ua, proxy } = req.body;
  console.log(`[Login Check] ${username}`);

  if (!proxy) {
    return res.status(400).json({ status: "error", message: "プロキシ情報がありません" });
  }

  try {
    const proxyAgent = new HttpsProxyAgent(proxy); // ★GASからのプロキシを使う
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
          'Cookie': cookieString,
          'User-Agent': ua
        }
      },
    });

    // ★修正：本当にログインできているか、自分の情報を取得してテストする
    const currentUser = await threadsAPI.getCurrentUser();
    // もしログインできていなければ、ここでエラーになるはず
    
    res.json({ status: "success", message: `完全ログイン成功！ User: ${currentUser.username}` });

  } catch (error) {
    console.error(`[Login Check] 失敗: ${error.message}`);
    // エラー詳細があればログに出す
    if (error.response) console.log(JSON.stringify(error.response.data));
    
    res.status(500).json({ status: "error", message: "ログイン失敗（Cookieまたはプロキシが不一致）" });
  }
});

// 2. 予約受付
app.post("/api/enqueue", (req, res) => {
  // proxy を受け取るように追加
  const { username, token, text, deviceId, imageUrl, csrftoken, ua, proxy } = req.body;
  
  if (!proxy) {
    return res.status(400).json({ status: "error", message: "プロキシ情報(L列)が不足しています" });
  }

  requestQueue.push({ username, token, text, deviceId, imageUrl, csrftoken, ua, proxy });
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
      // ★タスクごとのプロキシを使用
      const proxyAgent = new HttpsProxyAgent(task.proxy);
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
            'Cookie': cookieString,
            'User-Agent': task.ua
          }
        },
      });

      await threadsAPI.publish({ text: task.text, image: task.imageUrl });
      console.log(`✅ 投稿成功: ${task.username}`);

    } catch (error) {
      console.error(`❌ 投稿失敗 (${task.username}):`, error.message);
      if (error.response) {
        console.log("▼エラー詳細▼");
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
