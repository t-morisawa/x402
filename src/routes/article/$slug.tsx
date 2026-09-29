import { Link, createFileRoute } from '@tanstack/react-router'
import { PaidArticle } from '../../components/PaidArticle'
import { findArticle } from '../../data/articles'

export const Route = createFileRoute('/article/$slug')({
  loader: ({ params }) => ({ article: findArticle(params.slug) }),
  component: ArticlePage,
})

function ArticlePage() {
  const { article } = Route.useLoaderData()
  if (!article) {
    return <section className="not-found"><span>404 / NO STORY</span><h1>記事が見つかりません</h1><Link to="/">記事一覧に戻る ↗</Link></section>
  }

  return (
    <article className="story-page">
      <div className="story-topline"><Link to="/">← ALL STORIES</Link><span>ISSUE 001 <i>·</i> {article.date}</span></div>
      <header className="story-header">
        <div className="article-meta"><span>{article.category}</span><span>{article.readTime}</span></div>
        <h1>{article.title}</h1>
        <p className="story-lead">{article.lead}</p>
        <div className="story-author"><span className="author-avatar">{article.author.charAt(0)}</span><span>WORDS BY <strong>{article.author}</strong></span><span className="author-separator">/</span><span>{article.date}</span></div>
      </header>
      <div className={`story-visual story-visual-${article.visual}`}>
        <span className="story-visual-top">SIGNAL ORIGINAL<br />№ 001 / 2026</span>
        <span className="story-visual-title">THE<br />FUTURE<br /><i>IS OPEN.</i></span>
        <span className="story-visual-sun" />
        <span className="story-visual-bottom">A NEW WAY TO READ<br />AND PAY FOR THE WEB.</span>
      </div>
      <div className="free-preview">
        <span className="preview-label"><span /> FREE PREVIEW</span>
        <p>{article.lead}</p>
      </div>
      <PaidArticle article={article} />
      <div className="next-story"><span>MORE FROM SIGNAL</span><Link to="/">ほかの記事を読む <span>↗</span></Link></div>
    </article>
  )
}
