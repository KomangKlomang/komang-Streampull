import {
  dashLabel,
  dashRepIdFromUrl,
  dashVariantUrl,
  isoDuration,
  parseMpd,
  pickDashRep,
} from '../src/lib/mpd.js';

export default async function run({ check }) {
  check('PT durasi jam+menit+detik', Math.abs(isoDuration('PT1H2M3.5S') - 3723.5) < 0.001);
  check('PT detik saja', isoDuration('PT90S') === 90);

  const template = `<?xml version="1.0"?>
<MPD type="static" mediaPresentationDuration="PT30S">
  <Period>
    <AdaptationSet contentType="video" mimeType="video/mp4">
      <Representation id="v720" bandwidth="2000000" width="1280" height="720">
        <SegmentTemplate timescale="1" duration="10" startNumber="1"
          initialization="init-$RepresentationID$.mp4"
          media="chunk-$RepresentationID$-$Number%03d$.m4s"/>
      </Representation>
      <Representation id="v1080" bandwidth="5000000" width="1920" height="1080">
        <SegmentTemplate timescale="1" duration="10" startNumber="1"
          initialization="init-$RepresentationID$.mp4"
          media="chunk-$RepresentationID$-$Number$.m4s"/>
      </Representation>
    </AdaptationSet>
    <AdaptationSet contentType="audio" mimeType="audio/mp4">
      <Representation id="a64" bandwidth="64000">
        <SegmentList>
          <Initialization sourceURL="a-init.mp4"/>
          <SegmentURL media="a1.m4s"/>
          <SegmentURL media="a2.m4s"/>
        </SegmentList>
      </Representation>
    </AdaptationSet>
  </Period>
</MPD>`;
  const mpd = parseMpd(template, 'https://cdn.example.com/dash/manifest.mpd');
  check('bukan live', mpd.live === false);
  check('bukan DRM', mpd.drm === false);
  check('durasi MPD', mpd.duration === 30, String(mpd.duration));
  check('tiga representation', mpd.representations.length === 3, String(mpd.representations.length));

  const v1080 = mpd.representations.find((r) => r.id === 'v1080');
  check('init 1080 terselesaikan', v1080.init?.url === 'https://cdn.example.com/dash/init-v1080.mp4', v1080.init?.url);
  check('jumlah segmen dari duration', v1080.segments.length === 3, String(v1080.segments.length));
  check(
    'token $Number$ diisi',
    v1080.segments[0].url === 'https://cdn.example.com/dash/chunk-v1080-1.m4s',
    v1080.segments[0].url
  );

  const v720 = mpd.representations.find((r) => r.id === 'v720');
  check(
    'padding $Number%03d$',
    v720.segments[1].url.endsWith('chunk-v720-002.m4s'),
    v720.segments[1].url
  );

  const audio = mpd.representations.find((r) => r.id === 'a64');
  check('SegmentList audio', audio.segments.length === 2);
  check('init audio', audio.init?.url === 'https://cdn.example.com/dash/a-init.mp4', audio.init?.url);

  const best = pickDashRep(mpd);
  check('pilih video tertinggi', best?.id === 'v1080', best?.id);
  check('label 1080p', dashLabel(best).startsWith('1080p'), dashLabel(best));

  const picked = pickDashRep(mpd, 'v720');
  check('pilih by id', picked?.id === 'v720');

  const variant = dashVariantUrl('https://cdn.example.com/dash/manifest.mpd', 'v720');
  check('rep id dari hash', dashRepIdFromUrl(variant) === 'v720', dashRepIdFromUrl(variant));

  const live = parseMpd('<MPD type="dynamic"><Period></Period></MPD>', 'https://x.test/l.mpd');
  check('type=dynamic = live', live.live === true);

  const drm = parseMpd(
    '<MPD type="static"><Period><ContentProtection schemeIdUri="urn:uuid:edef8ba9-79d6-4ace-a3c8-27dcd51d21ed"/></Period></MPD>',
    'https://x.test/d.mpd'
  );
  check('ContentProtection = drm', drm.drm === true);

  const timeline = parseMpd(
    `<MPD mediaPresentationDuration="PT20S">
      <Period>
        <AdaptationSet contentType="video">
          <Representation id="t" bandwidth="1000" width="640" height="360">
            <SegmentTemplate media="s-$Time$.m4s" initialization="i.mp4" timescale="1">
              <SegmentTimeline>
                <S t="0" d="10" r="1"/>
              </SegmentTimeline>
            </SegmentTemplate>
          </Representation>
        </AdaptationSet>
      </Period>
    </MPD>`,
    'https://cdn.example.com/t.mpd'
  );
  const trep = timeline.representations[0];
  check('SegmentTimeline di-expand', trep.segments.length === 2, String(trep.segments.length));
  check(
    '$Time$ diisi',
    trep.segments[1].url === 'https://cdn.example.com/s-10.m4s',
    trep.segments[1].url
  );
}
