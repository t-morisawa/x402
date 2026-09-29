import { createFileRoute } from '@tanstack/react-router'
import { ArticleCard } from '../components/ArticleCard'
import { articles } from '../data/articles'

export const Route = createFileRoute('/')({ component: HomePage })

function HomePage() {
  const featured = articles[0]
  return (
    <>
      <section className="hero">
        <div className="hero-kicker"><span className="live-dot" /> INDEPENDENT IDEAS, ONE STORY AT A TIME</div>
        <h1>ニュースを読む、<br /><em>新しいかたち。</em></h1>
        <div className="hero-bottom">
          <p>テクノロジー、経済、カルチャー。<br />気になる記事だけを、気持ちよく読む。</p>
          <div className="hero-note"><span>NO SUBSCRIPTION</span><span>JUST 0.01 USDC / STORY</span></div>
        </div>
        <div className="hero-stamp">ISSUE<br /><strong>001</strong><br />2026</div>
      </section>

      {featured && (
        <section className="featured-section">
          <div className="section-heading"><span>FEATURED STORY</span><span>01 — 03</span></div>
          <div className="featured-card">
            <a href={`/article/${featured.slug}`} className={`featured-art art-${featured.visual}`} aria-label={featured.title}>
              <span className="featured-art-label">THE<br />NEXT<br /><i>ECONOMY</i></span>
              <span className="featured-art-sun" />
              <span className="featured-art-line" />
              <span className="featured-art-caption">A SIGNAL ORIGINAL / 2026</span>
            </a>
            <div className="featured-copy">
              <div className="article-meta"><span>{featured.category}</span><span>{featured.date}</span></div>
              <h2><a href={`/article/${featured.slug}`}>{featured.title}</a></h2>
              <p>{featured.lead}</p>
              <div className="featured-byline"><span>WORDS BY {featured.author.toUpperCase()}</span><span>{featured.readTime}</span></div>
              <a className="text-link" href={`/article/${featured.slug}`}>記事を読む <span>↗</span></a>
              <div className="price-tag"><span className="price-dot" /> 0.01 USDC <span>PER STORY</span></div>
            </div>
          </div>
        </section>
      )}

      <section className="latest-section">
        <div className="section-heading"><span>THE LATEST</span><span>SHORT READS, BIG IDEAS</span></div>
        <div className="article-grid">
          {articles.slice(1).map((article, index) => <ArticleCard key={article.slug} article={article} index={index + 1} />)}
        </div>
      </section>
      <section className="manifesto"><span>GOOD STORIES DESERVE<br />A BETTER INTERNET.</span><p>小さな決済からはじまる、<br />読み手と書き手の新しい関係。</p><span className="manifesto-mark">s.</span></section>
    </>
  )
}
