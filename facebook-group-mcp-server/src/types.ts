export interface FacebookPost {
  id: string;
  author: string;
  content: string;
  timestamp: string;
  url: string;
  comments: FacebookComment[];
}

export interface FacebookComment {
  author: string;
  content: string;
  timestamp: string;
}

export interface GroupData {
  groupId: string;
  groupName: string;
  lastScraped: string;
  posts: FacebookPost[];
}

export interface SearchResult {
  type: "post" | "comment";
  post: FacebookPost;
  comment?: FacebookComment;
  matchSnippet: string;
}

export interface ScraperConfig {
  groupUrl: string;
  dataDir: string;
  chromePath?: string;
  userDataDir?: string;
  scrollCount: number;
  headless: boolean;
}
