import { harvestIgResponse, igFetchHeaders, readCsrfToken } from '../src/lib/ig-media.js';

export default async function run({ check }) {
  const body = JSON.stringify({
    data: {
      items: [
        {
          video_versions: [{ width: 1080, url: 'https://scontent.cdninstagram.com/v/t50/x.mp4' }],
        },
      ],
    },
  });
  const urls = harvestIgResponse(body, 'https://www.instagram.com/graphql/query');
  check('GraphQL IG menghasilkan URL', urls.length === 1);
  check('readCsrfToken', readCsrfToken('a=1; csrftoken=abc123; b=2') === 'abc123');
  check('igFetchHeaders csrftoken', igFetchHeaders({ cookie: 'csrftoken=tok' })['x-csrftoken'] === 'tok');
}
