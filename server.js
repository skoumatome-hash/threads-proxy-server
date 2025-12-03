const express = require("express");
const { ThreadsAPI } = require("threads-api");
const { HttpsProxyAgent } = require("https-proxy-agent");
const app = express();

app.use(express.json());

const requestQueue = [];
let isProcessing = false;

// -------------------------------------------
//  Cookie文字列から特定のキーの値を抜き出す便利関数
// -------------------------------------------
function getCookieValue(cookieString, key) {
  if (!cookieString) return null;
  const match = cookieString.match(new RegExp('(^| )' + key + '=([^;]+)'));
  if (match) return match[2];
  return null;
}

// 1. ログイン確認
app.post("/api/check", async (req, res) => {
  const { username, fullCookie, deviceId, ua, proxy } = req.body;
  console.log(`[Login Check] ${username}`);

  if (!proxy || !fullCookie) {
    return res.status(400).json({ status: "error", message: "プロキシまたはCookie情報が不足しています" });
  }

  try {
    const proxyAgent = new HttpsProxyAgent(proxy);
    
    // ★修正: fullCookieの中から sessionid を探し出す
    const sessionid = getCookieValue(fullCookie, "sessionid");
    
    if (!sessionid) {
      throw new Error("Cookie文字列の中に sessionid が見つかりません。");
    }

    console.log(`SessionID抽出成功: ${sessionid.substring(0, 5)}...`);

    const threadsAPI = new ThreadsAPI({
      username: username,
      token: sessionid, // ★ダミーではなく、本物を渡す！
      deviceID: deviceId,
      axiosConfig: { 
        httpAgent: proxyAgent, 
        httpsAgent: proxyAgent,
        headers: {
          'Cookie': fullCookie, // ヘッダーには全部乗せ
          'User-Agent': ua
        }
      },
    });

    // ユーザーIDを取得
    const userID = await threadsAPI.getUserIDfromUsername(username);
    
    // 実際にプロフィールを取得してログイン検証
    // (ログインしていないとここでエラーになるか、nullが返る)
    const profile = await threadsAPI.getUserProfile(userID);
    
    res.json({ status: "success", message: `ログイン成功！ Name: ${profile.username} (ID: ${userID})` });

  } catch (error) {
    console.error(`[Login Check] 失敗: ${error.message}`);
    // エラー詳細
    if (error.response) {
      console.log(JSON.stringify(error.response.data));
      // 403やリダイレクト等の場合
      if (error.response.status === 403 || error.response.status === 302) {
         return res.status(403).json({ status: "error", message: "プロキシIP不一致またはCookie無効で弾かれました。" });
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
      
      // ★修正: ワーカー側も sessionid を抽出して渡す
      const sessionid = getCookieValue(task.fullCookie, "sessionid");

      const threadsAPI = new ThreadsAPI({
        username: task.username,
        token: sessionid || "dummy", // 万が一抽出できなくても落ちはしないように
        deviceID: task.deviceID,
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
