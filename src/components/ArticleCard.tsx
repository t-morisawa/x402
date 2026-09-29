import { Link } from '@tanstack/react-router'
import type { Article } from '../data/articles'

export function ArticleCard({ article, index }: { article: Article; index: number }) {
  return (
    <article className="article-card">
      <Link to="/article/$slug" params={{ slug: article.slug }} className={`card-art art-${article.visual}`} aria-label={article.title}>
        <span className="art-index">0{index + 1}</span>
        <span className="art-orbit art-orbit-one" />
        <span className="art-orbit art-orbit-two" />
        <span className="art-shape">{index === 0 ? '✳' : index === 1 ? '◒' : '◉'}</span>
        <span className="art-caption">SIGNAL / JOURNAL</span>
      </Link>
      <div className="card-copy">
        <div className="article-meta"><span>{article.category}</span><span>{article.date}</span></div>
        <h3><Link to="/article/$slug" params={{ slug: article.slug }}>{article.title}</Link></h3>
        <p>{article.lead}</p>
        <div className="card-footer"><span>{article.author}</span><span>{article.readTime}</span></div>
      </div>
    </article>
  )
}
