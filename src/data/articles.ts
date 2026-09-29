export type Article = {
  slug: string
  category: string
  title: string
  lead: string
  author: string
  date: string
  readTime: string
  visual: string
}

export const articles: Article[] = [
  {
    slug: 'ai-agents-economy',
    category: 'TECHNOLOGY',
    title: 'AIエージェントは、どうやって自分で買い物をするのか',
    lead: '人の代わりにサービスを探し、必要な分だけ支払う。自律型エージェントの経済圏を支える「HTTP 402」の新しい使い方。',
    author: '水野 玲',
    date: '2026.09.18',
    readTime: '6 min read',
    visual: 'violet',
  },
  {
    slug: 'stablecoin-everyday',
    category: 'FINANCE',
    title: 'ステーブルコインが「送金」から「決済」へ変わる日',
    lead: '価格の安定だけではない。インターネット上の小さな取引を、国境や営業時間を越えてつなぐ新しい決済レール。',
    author: '高橋 葵',
    date: '2026.09.12',
    readTime: '5 min read',
    visual: 'orange',
  },
  {
    slug: 'web-micropayments',
    category: 'CULTURE',
    title: '「読むたびに払う」ウェブは、メディアを救うのか',
    lead: '広告か、月額購読か。その二択のあいだに、記事一つから始められるマイクロペイメントという選択肢が生まれている。',
    author: '佐々木 透',
    date: '2026.09.05',
    readTime: '7 min read',
    visual: 'green',
  },
]

export function findArticle(slug: string) {
  return articles.find((article) => article.slug === slug)
}
