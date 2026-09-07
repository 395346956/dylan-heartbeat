require('dotenv').config();
const fs = require('fs-extra');
const path = require('path');
const cron = require('node-cron');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const HEARTBEAT_URL = process.env.HEARTBEAT_URL || 'http://localhost:3000/internal/heartbeat';
const BARK_KEY = process.env.BARK_KEY;
const PUSH_PROVIDER = process.env.PUSH_PROVIDER || 'bark';
const TARGET_API_URL = process.env.TARGET_API_URL;
const TARGET_API_KEY = process.env.TARGET_API_KEY;

// ===== 工具函数 =====

function getDataFilePath() {
    return path.join(DATA_DIR, 'enhanced_messages.json');
}

function loadTimelineMessages() {
    const filePath = getDataFilePath();
    if (!fs.existsSync(filePath)) {
        return [];
    }
    try {
        const content = fs.readFileSync(filePath, 'utf-8');
        const data = JSON.parse(content);
        return data.messages || [];
    } catch (e) {
        console.error('读取消息记录失败:', e);
        return [];
    }
}

function normalizeContentToText(content) {
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
        return content.map(c => c.text || '').join('');
    }
    return '';
}

function parseTimelineTimestamp(text) {
    if (!text || typeof text !== 'string') return null;
    // 匹配 YYYY-MM-DD HH:mm 或 YYYY-MM-DDHH:mm
    const match = text.match(/^(\d{4}-\d{2}-\d{2})\s*(\d{2}):(\d{2})/);
    if (match) {
        const dateStr = `${match[1]} ${match[2]}:${match[3]}`;
        const ts = new Date(dateStr).getTime();
        if (!isNaN(ts)) return ts;
    }
    return null;
}

function getLastUserTime(messages) {
    const reversed = [...messages].reverse();
    for (const msg of reversed) {
        if (msg.role === "user") {
            const content = normalizeContentToText(msg.content);
            const parsed = parseTimelineTimestamp(content);
            if (parsed) return parsed;
            if (msg.created_at) {
                return new Date(msg.created_at).getTime();
            }
        }
    }
    return null;
}

function getLastAITime(messages) {
    const reversed = [...messages].reverse();
    for (const msg of reversed) {
        if (msg.role === "assistant" || msg.role === "ai") {
            const content = normalizeContentToText(msg.content);
            const parsed = parseTimelineTimestamp(content);
            if (parsed) return parsed;
            if (msg.created_at) {
                return new Date(msg.created_at).getTime();
            }
        }
    }
    return null;
}

function getWakeAfterMinutes(now) {
    const hour = now.getHours();
    // 白天 10:00 - 24:00 用 DAY_WAKE_AFTER_MINUTES（默认60）
    // 夜间 0:00 - 10:00 用 NIGHT_WAKE_AFTER_MINUTES（默认120）
    if (hour >= 10 && hour < 24) {
        return parseInt(process.env.DAY_WAKE_AFTER_MINUTES) || 60;
    } else {
        return parseInt(process.env.NIGHT_WAKE_AFTER_MINUTES) || 120;
    }
}

function getCheckIntervalMinutes(now) {
    const hour = now.getHours();
    if (hour >= 10 && hour < 24) {
        return parseInt(process.env.DAY_CHECK_INTERVAL_MINUTES) || 10;
    } else {
        return parseInt(process.env.NIGHT_CHECK_INTERVAL_MINUTES) || 120;
    }
}

function getCheckIntervalMs() {
    return getCheckIntervalMinutes(new Date()) * 60 * 1000;
}

// ===== 推送函数 =====

async function sendBarkNotification(title, body) {
    if (!BARK_KEY) {
        console.log('❌ BARK_KEY 未配置');
        return;
    }
    try {
        const payload = {
            title: title || '🧠 唤醒提醒',
            body: body || '该起来看看消息了！',
            device_key: BARK_KEY,
            icon: process.env.CUSTOM_ICON_URL
        };
        const response = await fetch('https://api.day.app/push', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });
        if (response.ok) {
            console.log('✅ Bark 推送成功');
        } else {
            console.log(`❌ Bark 推送失败: ${response.status}`);
        }
    } catch (e) {
        console.error('❌ Bark 推送异常:', e.message);
    }
}

// ===== 主唤醒函数 =====

async function runWakeUp() {
    console.log('\n==========================================');
    console.log('开始自动唤醒');
    console.log('==========================================\n');

const messages = loadTimelineMessages();
console.log(`📊 加载到 ${messages.length} 条消息`);  // ← 改成反引号

if (!messages || messages.length === 0) {
    console.log('没有消息记录，跳过唤醒');
    return;
}

// 👇 新增：打印第一条消息的结构
if (messages.length > 0) {
    console.log('📝 第一条消息:', JSON.stringify(messages[0]));
}

const lastUserTime = getLastUserTime(messages);
if (!lastUserTime) {
    console.log('❌ 未找到用户时间');
    return;
}

console.log(`✅ 用户最后消息时间：${new Date(lastUserTime).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}`);  // ← 改成反引号
    const lastAITime = getLastAITime(messages);
    if (!lastAITime) {
        console.log('❌ 未找到 AI 回复时间');
        return;
    }
    console.log(`✅ AI 最后回复时间: ${new Date(lastAITime).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}`);

    // 如果用户最后消息 > AI 最后回复，说明用户已经看过并回复了
    if (lastUserTime > lastAITime) {
        console.log('✅ 用户已回复过 AI 的最新消息，不需要唤醒');
        return;
    }

    const now = Date.now();
    const minutesSinceLastUser = (now - lastUserTime) / (1000 * 60);
    console.log(`⏱️ 距离用户最后一条消息已过 ${Math.round(minutesSinceLastUser)} 分钟`);

    const wakeAfter = getWakeAfterMinutes(new Date());
    if (minutesSinceLastUser < wakeAfter) {
        console.log(`⏳ 未达到唤醒阈值（需 ${wakeAfter} 分钟），本次不推送`);
        return;
    }

    console.log('🚀 触发唤醒条件！准备发送推送...');
    await sendBarkNotification(
        '💬 唤醒提醒',
        `你已经 ${Math.round(minutesSinceLastUser)} 分钟没有回复了，AI 还在等你呢！`
    );
    console.log('==========================================\n');
}

// ===== 调度循环 =====

async function scheduleNextCheck() {
    try {
        await fetch(HEARTBEAT_URL, { method: 'POST' });
    } catch (e) {
        console.error('⚠️ 心跳失败:', e.message);
        await runWakeUp();
    }
    setTimeout(scheduleNextCheck, getCheckIntervalMs());
}

// ===== 启动 =====

fs.ensureDirSync(DATA_DIR);

console.log('\n==========================================');
console.log('Dylan Heartbeat Runtime 已启动（动态间隔）');
console.log(JSON.stringify({
    event: 'wake_runtime_config_summary',
    railway: Boolean(process.env.RAILWAY_ENVIRONMENT || process.env.RAILWAY_PROJECT_ID || process.env.RAILWAY_SERVICE_ID),
    persistent_data: Boolean(process.env.DATA_DIR || process.env.RAILWAY_VOLUME_MOUNT_PATH),
    target_url_configured: Boolean(process.env.TARGET_API_URL),
    target_key_configured: Boolean(process.env.TARGET_API_KEY),
    model_configured: Boolean(process.env.MODEL_NAME),
    push_provider_configured: Boolean(process.env.BARK_KEY || process.env.NTFY_TOPIC),
    data_dir_ready: fs.existsSync(DATA_DIR)
}));
console.log('==========================================\n');

setTimeout(scheduleNextCheck, 10_000);
