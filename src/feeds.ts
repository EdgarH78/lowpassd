export interface Feed {
  slug: string;
  url: string;
  // dense=true routes articles from this feed to the Pro tier (denser, research-heavy sources).
  dense?: boolean;
  // prefilter=true triages items by title+abstract through a cheap Flash call
  // at ingest time, storing only those relevant to the wiki taxonomy. Used for
  // high-volume, low-hit-rate firehoses (arXiv) to avoid ingesting hundreds of
  // off-topic papers and paying to categorize each one.
  prefilter?: boolean;
}

export const defaultFeeds: Feed[] = [
  // Hugging Face has no official RSS; this is the community-maintained takara.ai feed.
  { slug: 'huggingface-papers', url: 'https://papers.takara.ai/api/feed', dense: true },
  // Anthropic has no official RSS; this is a community-maintained scraper.
  { slug: 'anthropic-news', url: 'https://raw.githubusercontent.com/taobojlen/anthropic-rss-feed/main/anthropic_news_rss.xml' },
  { slug: 'openai-news', url: 'https://openai.com/news/rss.xml' },
  { slug: 'deepmind-blog', url: 'https://deepmind.google/blog/rss.xml' },
  { slug: 'simonw', url: 'https://simonwillison.net/atom/everything/' },
  { slug: 'addy-osmani', url: 'https://addyosmani.com/rss.xml' },
  { slug: 'import-ai', url: 'https://importai.substack.com/feed' },
  { slug: 'the-gradient', url: 'https://thegradient.pub/rss/' },

  // Agent-framework providers. LangChain's blog proper, Mastra, BAML, Pydantic
  // AI and Haystack expose no RSS (JS marketing sites), so they can't be added
  // without a scraper. These are the ones with working official feeds:
  // LangChain ships product/LangGraph news via its changelog (the blog has no feed).
  { slug: 'langchain-changelog', url: 'https://changelog.langchain.com/feed' },
  { slug: 'crewai', url: 'https://blog.crewai.com/rss/' },
  // Microsoft Agent Framework — the active successor to AutoGen.
  { slug: 'ms-agent-framework', url: 'https://devblogs.microsoft.com/agent-framework/feed/' },

  // arXiv firehoses: high volume, low hit rate. prefilter triages by
  // title+abstract so only papers relevant to the taxonomy are ingested.
  { slug: 'arxiv-cs-lg', url: 'http://export.arxiv.org/rss/cs.LG', prefilter: true },
  { slug: 'arxiv-cs-cl', url: 'http://export.arxiv.org/rss/cs.CL', prefilter: true },
  { slug: 'arxiv-cs-ai', url: 'http://export.arxiv.org/rss/cs.AI', prefilter: true },
];
