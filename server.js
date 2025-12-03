const express = require("express");
const puppeteer = require("puppeteer");
const app = express();

app.use(express.json());

const requestQueue = [];
let isProcessing = false;

// Cookie解析
function parseCookies(input) {
  const cookies = [];
  if (!input) return cookies;
  const trimmed = input.trim();

  if (trimmed.startsWith("[") || trimmed.startsWith("{")) {
    try {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed)) {
        parsed.forEach(c => {
          cookies.push({
            name: c.name,
            value: c.value,
            domain: ".threads.net",
            path: "/",
            secure: true,
            httpOnly: c.httpOnly !== undefined ? c.httpOnly : true
          });
        });
      }
    } catch (e) { console.error("Cookie JSON解析エラー:", e); }
  } else {
    trimmed.split(';').forEach(part => {
      const [key, ...v] = part.trim().split('=');
      if (key && v.length > 0) {
        cookies.push({
          name: key,
          value: v.join('='),
          domain: ".threads.net",
          path: "/",
          secure: true
        });
      }
    });
  }
  return cookies;
}

// プロキシ解析
function parseProxy(proxyStr) {
  if (!proxyStr) return null;
  if (!proxyStr.startsWith("http")) {
    const parts = proxyStr.split(':');
    if (parts.length === 4) {
      return { server: `${parts[0]}:${parts[1]}`, username: parts[2], password: parts[3] };
    }
  }
  try {
    const url = new URL(proxyStr.startsWith("http") ? proxyStr : `http://${proxyStr}`);
    return { server: `${url.hostname}:${url.port}`, username: url.username, password: url.password };
  } catch (e) { return null; }
}

// メイン処理
async function runPuppeteerPost(task) {
  let browser = null;
  try {
    console.log("🚀 ブラウザ起動準備...");
    
    const proxyData = parseProxy(task.proxy);
    const args = [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--single-process',
      '--no-zygote',
      '--disable-notifications',
      '--window-size=1920,1080'
    ];

    if (proxyData) {
      args.push(`--proxy-server=${proxyData.server}`);
      console.log(`🌐 プロキシ設定: ${proxyData.server}`);
    }

    browser = await puppeteer.launch({ args: args, headless: "new" });
    const page = await browser.newPage();
    await page.setViewport({ width: 1920, height: 1080 });

    if (proxyData && proxyData.username) {
      await page.authenticate({ username: proxyData.username, password: proxyData.password });
    }

    await page.setUserAgent(task.ua || "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36");

    const cookies = parseCookies(task.fullCookie);
    if (cookies.length > 0) {
      await page.setCookie(...cookies);
      console.log(`🍪 Cookie ${cookies.length}個をセットしました`);
    }

    console.log("🌍 Threadsにアクセス中...");
    await page.goto("https://www.threads.net/", { waitUntil: 'networkidle2', timeout: 120000 });

    // ページ読み込み完了まで少し待つ
    await new Promise(r => setTimeout(r, 5000));

    // ★修正: 投稿エリアを探す (タイムアウトを60秒に延長)
    const textBoxSelector = 'div[role="textbox"], div[data-lexical-editor="true"]';
    
    console.log("🔍 「作成」ボタンを探しています...");
    let createdOpened = false;

    try {
      // ボタンを探す
      await page.waitForSelector('svg[aria-label="Create"], svg[aria-label="作成"]', { timeout: 15000 });
      const createBtn = await page.$('svg[aria-label="Create"], svg[aria-label="作成"]');
      
      if (createBtn) {
        // 念のためJavaScriptでクリック発火
        await page.evaluate(el => el.click(), createBtn);
        console.log("✅ 「作成」ボタンをクリックしました");
        
        // クリック後、入力欄が出るか30秒待つ
        try {
          await page.waitForSelector(textBoxSelector, { timeout: 30000 });
          createdOpened = true;
        } catch(e) {
          console.log("⚠️ ボタンを押しましたが入力欄が出ません。直接ページへ移動します。");
        }
      }
    } catch (e) {
      console.log("⚠️ 「作成」ボタンが見つかりません。直接ページへ移動します。");
    }

    // ボタンで見つからなかった場合、直接URLへ
    if (!createdOpened) {
      console.log("🔄 投稿ページ(threads.net/create)へ直接移動します...");
      await page.goto("https://www.threads.net/create", { waitUntil: 'networkidle2', timeout: 60000 });
    }

    // 最終確認: 入力欄があるか (60秒待つ)
    console.log("⏳ 投稿入力欄を待機中(最大60秒)...");
    await page.waitForSelector(textBoxSelector, { timeout: 60000 });
    console.log("✅ 入力欄を発見！");

    // 入力処理
    console.log("✍️ テキスト入力中...");
    await page.click(textBoxSelector);
    await new Promise(r => setTimeout(r, 1000));
    
    // 確実に入力するため、少しゆっくり打つ
    await page.type(textBoxSelector, task.text, { delay: 100 });
    await new Promise(r => setTimeout(r, 3000));

    // 「Post」ボタンを探してクリック
    console.log("🔘 投稿実行ボタンを探しています...");
    const postBtn = await page.evaluateHandle(() => {
      const buttons = Array.from(document.querySelectorAll('div[role="button"]'));
      return buttons.find(b => 
        (b.innerText === "Post" || b.innerText === "投稿") && 
        !b.hasAttribute('disabled') // 無効化されていないボタンを探す
      );
    });

    if (postBtn) {
      // 念のためスクロールして表示させる
      await postBtn.hover();
      await new Promise(r => setTimeout(r, 500));
      await postBtn.click();
      
      console.log("✅ ボタンをクリックしました！ 投稿完了待ち...");
      await new Promise(r => setTimeout(r, 15000)); // 投稿完了までたっぷり待つ
      console.log(`🎉 投稿成功: ${task.username}`);
    } else {
      // ボタンがない場合のデバッグ
      const bodyText = await page.evaluate(() => document.body.innerText.substring(0, 300));
      console.log(`画面テキスト: ${bodyText}`);
      throw new Error("「投稿」ボタンが見つからないか、押せない状態です。");
    }

  } catch (error) {
    console.error(`❌ 処理失敗: ${error.message}`);
    throw error;
  } finally {
    if (browser) {
      await browser.close();
      console.log("🔒 ブラウザを閉じました");
    }
  }
}

app.post("/api/check", async (req, res) => {
  res.json({ status: "success", message: "★Puppeteerサーバー稼働中！「投稿」を実行してください。" });
});

app.post("/api/enqueue", (req, res) => {
  const { username, fullCookie, text, deviceId, imageUrl, ua, proxy } = req.body;
  requestQueue.push({ username, fullCookie, text, deviceId, imageUrl, ua, proxy });
  console.log(`[受付] ${username} を予約`);
  res.json({ status: "queued", message: "予約完了" });
  processQueue();
});

async function processQueue() {
  if (isProcessing || requestQueue.length === 0) return;
  isProcessing = true;

  while (requestQueue.length > 0) {
    const task = requestQueue.shift();
    console.log(`\n--- 処理開始 (Puppeteer): ${task.username} ---`);
    try {
      await runPuppeteerPost(task);
    } catch (error) {
      console.error(`❌ 投稿失敗 (${task.username}):`, error.message);
    }
    if (requestQueue.length > 0) {
      console.log("☕ 休憩中...");
      await new Promise((resolve) => setTimeout(resolve, 30000));
    }
  }
  isProcessing = false;
}

const listener = app.listen(process.env.PORT, () => {
  console.log("Server started");
});
