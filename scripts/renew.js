const { chromium } = require('playwright');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

// 环境变量获取
const EMAIL = process.env.H2P_EMAIL;
const PASSWORD = process.env.H2P_PASSWORD;
const TARGET_URL = process.env.RENEW_URL;
const PROXY_JSON = process.env.PROXY_JSON;

const EXTENSION_PATH = path.join(__dirname, 'extensions', 'nopecha', 'unpacked');

async function startProxy() {
    console.log('[初始化] 准备 Hysteria2 代理配置...');
    fs.writeFileSync('config.json', PROXY_JSON);

    console.log('[Hysteria2] starts...');
    const hysteria = spawn('hysteria', ['-c', 'config.json']);
    
    hysteria.stdout.on('data', (data) => console.log(`[Hysteria2 Log]: ${data}`));
    hysteria.stderr.on('data', (data) => console.error(`[Hysteria2 Error]: ${data}`));

    // 等待代理启动
    await new Promise(resolve => setTimeout(resolve, 5000));
    console.log('[Hysteria2] socks5: 127.0.0.1:10808 预计已就绪');
    return hysteria;
}

async function run() {
    let proxyProcess;
    if (PROXY_JSON) {
        proxyProcess = await startProxy();
    }

    console.log('[Playwright] 启动中...');
    const userDataDir = '/tmp/playwright_user_data';
    
    const context = await chromium.launchPersistentContext(userDataDir, {
        headless: false, // 必须为 false 才能加载扩展，Actions 中由 xvfb 提供虚拟显示器
        proxy: { server: 'socks5://127.0.0.1:10808' },
        args: [
            `--disable-extensions-except=${EXTENSION_PATH}`,
            `--load-extension=${EXTENSION_PATH}`,
            '--no-sandbox',
            '--disable-setuid-sandbox'
        ]
    });

    const page = await context.newPage();
    console.log('[浏览器] 启动完成...');

    try {
        console.log('[页面] 访问公开续期链接...');
        // 直接访问公开续期链接，跳过登录
        await page.goto(TARGET_URL, { timeout: 60000 });
        
        console.log('[交互] 等待页面加载和 NopeCHA 自动处理验证码...');
        // 给 NopeCHA 留出 15-20 秒的时间去搞定页面上的 reCAPTCHA
        await page.waitForTimeout(20000); 

        // 查找并点击 Renew/确认 按钮
        console.log('[交互] 查找续期按钮...');
        const renewButton = page.locator('button:has-text("Renew"), a:has-text("Renew"), button:has-text("Confirm")').first();
        
        if (await renewButton.isVisible()) {
            await renewButton.click();
            console.log('[成功] 续期按钮已点击！');
            await page.waitForTimeout(5000); // 等待反馈弹窗或页面刷新
        } else {
            console.log('[跳过] 未找到续期按钮，可能验证码未通过，或尚未到续期时间。');
        }

        // 截图留存验证
        await page.screenshot({ path: path.join(__dirname, 'screenshots', 'renew_done.png'), fullPage: true });
        console.log('[截图] 已保存到 screenshots/renew_done.png');

    } catch (error) {
        console.error('[错误] 运行中断:', error);
        await page.screenshot({ path: path.join(__dirname, 'screenshots', 'error.png'), fullPage: true });
    } finally {
        await context.close();
        if (proxyProcess) proxyProcess.kill();
        console.log('[结束] 任务完成，清理进程。');
    }
}

run();
