export interface Feed {
  slug: string;
  url: string;
  // dense=true routes articles from this feed to the Pro tier (e.g. arXiv papers).
  dense?: boolean;
}

export const defaultFeeds: Feed[] = [
  { slug: 'arxiv-cs-lg', url: 'http://export.arxiv.org/rss/cs.LG', dense: true },
  { slug: 'arxiv-cs-cl', url: 'http://export.arxiv.org/rss/cs.CL', dense: true },
  { slug: 'arxiv-cs-ai', url: 'http://export.arxiv.org/rss/cs.AI', dense: true },
  // Hugging Face has no official RSS; this is the community-maintained takara.ai feed.
  { slug: 'huggingface-papers', url: 'https://papers.takara.ai/api/feed', dense: true },
  // Anthropic has no official RSS; this is a community-maintained scraper.
  { slug: 'anthropic-news', url: 'https://raw.githubusercontent.com/taobojlen/anthropic-rss-feed/main/anthropic_news_rss.xml' },
  { slug: 'openai-news', url: 'https://openai.com/news/rss.xml' },
  { slug: 'deepmind-blog', url: 'https://deepmind.google/blog/rss.xml' },
  { slug: 'simonw', url: 'https://simonwillison.net/atom/everything/' },
  { slug: 'import-ai', url: 'https://importai.substack.com/feed' },
  { slug: 'the-gradient', url: 'https://thegradient.pub/rss/' },
];
