import dotenv from "dotenv"
dotenv.config()

import { onSchedule } from 'firebase-functions/v2/scheduler'
import { onRequest } from 'firebase-functions/v2/https'
import * as logger from 'firebase-functions/logger'
import * as admin from 'firebase-admin'
import * as nodemailer from 'nodemailer'
import Parser from 'rss-parser'
import * as cheerio from 'cheerio'
import OpenAI from 'openai'


admin.initializeApp()
const db = admin.firestore()

const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY
})

const RSS_SOURCES = [
    { name: 'Billboard', url: 'https://www.billboard.com/feed/' },
    { name: 'Rolling Stone', url: 'https://www.rollingstone.com/music/music-news/feed/' },
    { name: 'NME', url: 'https://www.nme.com/feed' },
    { name: 'Pitchfork', url: 'https://pitchfork.com/feed/feed-news/rss' },
    { name: 'Variety Music', url: 'https://variety.com/c/music/feed/' }
]

interface NewsItem {
    source: string
    title: string
    link: string
    summary: string
    thumbnail: string
    pubDate: Date
    interestLevel?: number
}

interface UserData {
    email: string
    isSubscribed: boolean
}

async function analyzeNewsWithAI(title: string, rawText: string): Promise<{ isValid: boolean, summary: string, interestLevel?: number }> {
    try {
        const completion = await openai.chat.completions.create({
            model: 'gpt-4o-mini',
            messages: [
                {
                    role: 'system',
                    content: `
                    너는 엄격한 음악 뉴스 큐레이터야.
                    다음 기준에 따라 기사를 필터링하고 요약해.

                    [판단 기준]
                    - **거짓(false)**: 쇼핑/할인/선물추천(Gift Guide), 단순 가십, 정치, 영화/드라마 리뷰, 'Best of' 리스트, 광고성 기사.
                    - **참(true)**: 아티스트의 새 앨범/곡 발매, 투어 소식, 인터뷰, 음악 산업의 중요한 뉴스, 시상식 결과.

                    [요약 규칙]
                    - isValid가 true일 때만 요약 작성.
                    - isValid가 true일 때만 흥미로움 정도(1~100) 평가. 요즘 루키, 인디 아티스트 관련 내용은 더 높게 평가. 힙합/알앤비 관련 내용도 선호. 신곡, 투어, 앨범 소식은 더 높게 평가.
                    - 한국어로 작성.
                    - **경어체(해요체)** 사용 (예: 했습니다, 보여줍니다).
                    - 핵심 내용만 2~3문장으로 간결하게.
                    
                    응답 형식(JSON): { "isValid": boolean, "summary": string, "interestLevel": number }
                    `
                },
                {
                    role: 'user',
                    content: `제목: ${title}\n내용: ${rawText}`
                }
            ],
            response_format: { type: 'json_object' },
            temperature: 0.3 // 분석은 냉정하게
        })
        
        const result = JSON.parse(completion.choices[0].message.content || '{}')
        return {
            isValid: result.isValid || false,
            summary: result.summary || ''
        }
        
    } catch (error) {
        logger.error('AI 분석 에러:', error)
        return { isValid: false, summary: '', interestLevel: 0 }
    }
}

// 개별 소스 수집
async function fetchNewsFromSource(sourceName: string, rssUrl: string, parser: Parser): Promise<NewsItem[]> {
    try {
        const feed = await parser.parseURL(rssUrl)
        const yesterday = new Date()
        yesterday.setDate(yesterday.getDate() - 1)
        
        const candidates = feed.items.filter((item) => {
            const pubDate = new Date(item.pubDate!)
            return pubDate > yesterday
        }).slice(0, 20)
        
        // Promise.all로 동시에 검사
        const results = await Promise.all(candidates.map(async (item) => {
            // 이미지 추출
            let thumbnail = ''
            if (item['media:content']?.['$']?.['url']) thumbnail = item['media:content']['$']['url']
            else if (item.enclosure?.url) thumbnail = item.enclosure.url
            else if (item['content:encoded']) {
                const $ = cheerio.load(item['content:encoded'])
                thumbnail = $('img').first().attr('src') || $('img').first().attr('data-lazy-src') || ''
            }
            if (thumbnail && thumbnail.includes('?')) thumbnail = thumbnail.split('?')[0]
            
            // if (!thumbnail) return null
            
            const $ = cheerio.load(item['content:encoded'] || item.content || item.summary || '')
            const rawText = $.text().replace(/\s\s+/g, ' ').trim().substring(0, 600)
            
            const aiResult = await analyzeNewsWithAI(item.title || '', rawText)
            
            if (aiResult.isValid) {
                return {
                    source: sourceName,
                    title: item.title || '제목 없음',
                    link: item.link || '',
                    summary: aiResult.summary,
                    thumbnail: thumbnail,
                    pubDate: new Date(item.pubDate!),
                    interestLevel: aiResult.interestLevel ?? 0
                } as NewsItem
            }
            return null
        }))
        
        return results.filter((item): item is NewsItem => item !== null)
        
    } catch (error) {
        logger.error(`${sourceName} 파싱 실패:`, error)
        return []
    }
}

// 전체 수집
async function getAllMusicNews(): Promise<NewsItem[]> {
    const parser = new Parser({ customFields: { item: ['content:encoded', 'media:content'] } })
    
    const results = await Promise.all(RSS_SOURCES.map(source =>
        fetchNewsFromSource(source.name, source.url, parser)
    ))
    
    // 중요도 및 최신순 정렬
    const allNews = results.flat().sort((a, b) => (b.interestLevel ?? 0) - (a.interestLevel ?? 0) || b.pubDate.getTime() - a.pubDate.getTime())
    
    // 15개 필터링
    return allNews.slice(0, 15)
}

export const testCrawler = onRequest(async (req, res) => {
    const result = await getAllMusicNews()
    res.json({ count: result.length, data: result })
}) // 테스트용 HTTP 함수

const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: { user: process.env.MAIL_USER, pass: process.env.MAIL_PASS }
})

export const sendDailyMusicNews = onSchedule(
    {
        schedule: '0 9 * * *',
        timeZone: 'Asia/Seoul',
        region: 'asia-northeast3',
        timeoutSeconds: 540,
        memory: '1GiB'
    },
    async (event) => {
        logger.info('뉴스레터 전송 시작.')
        try {
            const newsData = await getAllMusicNews()
            
            if (newsData.length === 0) {
                logger.info('뉴스 정보를 불러오지 못했습니다.')
                return
            }
            
            const usersSnapshot = await db.collection('users').where('isSubscribed', '==', true).get()
            const emails = usersSnapshot.docs.map(doc => (doc.data() as UserData).email).filter(e => e)
            
            if (emails.length === 0) return
            
            const newsItemsHtml = newsData.map(item => `
                <div style='margin-bottom: 40px; border-bottom: 1px solid #eee; padding-bottom: 30px;'>
                    <div style='font-size: 11px; color: #ff0050; font-weight: 800; text-transform: uppercase; margin-bottom: 8px;'>
                        ${item.source}
                    </div>
                    <a href='${item.link}' style='text-decoration: none; color: #111;'>
                        <img src='${item.thumbnail}' style='width: 100%; border-radius: 12px; margin-bottom: 15px; box-shadow: 0 4px 12px rgba(0,0,0,0.05);' />
                        <h3 style='margin: 0 0 12px 0; font-size: 22px; line-height: 1.3;'>${item.title}</h3>
                    </a>
                    <p style='font-size: 16px; color: #444; line-height: 1.6; margin: 0; word-break: keep-all;'>
                        ${item.summary}
                    </p>
                </div>
            `).join('')
            
            const today = new Date().toLocaleDateString('ko-KR', { month: 'long', day: 'numeric', weekday: 'long' })
            
            const htmlContent = `
                <div style="max-width: 640px; margin: 0 auto; font-family: 'Apple SD Gothic Neo', 'Malgun Gothic', sans-serif; padding: 20px; background-color: #fff;">
                    <h1 style='text-align: center; font-size: 28px; margin-bottom: 5px;'>🎵 Musive Briefing</h1>
                    <p style='text-align: center; color: #888; margin-top: 0; margin-bottom: 40px;'>${today}</p>
                    ${newsItemsHtml}
                    <div style='text-align: center; margin-top: 50px; font-size: 12px; color: #aaa;'>
                        <p>AI가 엄선하여 요약한 음악 뉴스입니다.</p>
                        © 2025 Musive
                    </div>
                </div>
            `
            
            await transporter.sendMail({
                from: '"Musive" <my-email@gmail.com>',
                bcc: emails,
                subject: `${today}의 음악 뉴스레터 (${newsData.length}건)`,
                html: htmlContent
            })
            
            logger.info(`✅ 전송 완료: ${emails.length}명`)
        } catch (error) {
            logger.error('❌ 실패:', error)
        }
    }
)