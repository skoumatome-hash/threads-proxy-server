const express = require("express");
const { ThreadsAPI } = require("threads-api");
const { HttpsProxyAgent } = require("https-proxy-agent");
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
//  プロキシ形式変換 (host:port:user:pass -> http://...)
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

// 1. ログイン確認
app.post("/api/check", async (req, res) => {
  const { username, fullCookie, ua, proxy } = req.body;
  console.log(`[Login Check] ${username}`);

  if (!proxy || !fullCookie) return res.status(400).json({ status: "error", message: "情報不足" });

  try {
    // CookieからIDとセッションを抜く
    const sessionid = getCookieValue(fullCookie, "sessionid");
    const userID = getCookieValue(fullCookie, "ds_user_id");

    if (!sessionid || !userID) {
      return res.status(400).json({ status: "error", message: "Cookieからsessionidまたはds_user_idが見つかりません" });
    }

    // ★セッションIDが生きていれば、これだけで十分
    res.json({ status: "success", message: `★ID抽出OK: ${userID}\n(セッションID: ${sessionid.substring(0,5)}...)` });

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
      
      // 必要な情報を抽出
      const sessionid = getCookieValue(task.fullCookie, "sessionid");
      const userID = getCookieValue(task.fullCookie, "ds_user_id");
      const ig_did = getCookieValue(task.fullCookie, "ig_did") || task.deviceId;

      // ★ここが重要：ライブラリを「認証済み状態」で起動する
      const threadsAPI = new ThreadsAPI({
        username: task.username,
        token: sessionid,  // ★本物のセッションIDを渡す！
        deviceID: ig_did,  // ★本物のデバイスIDを渡す！
        axiosConfig: { 
          httpAgent: proxyAgent, 
          httpsAgent: proxyAgent,
          headers: {
            'User-Agent': task.ua,     // ★ADSPOWERのUA
            'Cookie': task.fullCookie  // ★念のため全Cookieも渡す
          }
        },
      });

      // ★余計なチェック(getUserProfile等)は一切せず、いきなり投稿する！
      console.log("投稿リクエスト送信...");
      await threadsAPI.publish({ text: task.text, image: task.imageUrl });
      
      console.log(`✅ 投稿成功: ${task.username}`);

    } catch (error) {
      console.error(`❌ 投稿失敗 (${task.username}):`, error.message);
      // 詳細ログ
      if (error.response) {
        console.log("--- Error Response ---");
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
