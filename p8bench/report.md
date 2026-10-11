# p8bench Report

## 总览

| model | mean | errors | acg_knowledge | culture_knowledge | emotion_alignment | game | general_reasoning | geo_knowledge | image_detail | insight | language_reasoning | long_tail_knowledge | maths | subtle_attention | token_efficiency | vision | vision_reasoning | world_knowledge |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| gemini-3.8-flash-exp-a | 0.7275 | 0 | 0.3333 | 0.94 | 1 | 1 | 1 | 1 | 0.94 | 1 | 1 | 0.5 | 0.895 | 1 | 0.895 | 0.86 | 1 | 0.6175 |

## 明细

| task | gemini-3.8-flash-exp-a |
| --- | ---: |
| frp_tcp_meltdown | 1 |
| integration_by_substitution | 0.79 |
| know_aqua_friends | 0 |
| know_deco27_thanks_songs | 0.5 |
| know_ken_brennan | 0 |
| know_twitch_raid | 1 |
| subtle_lyrics_discovery | 1 |
| sym_sum | 1 |
| debug_mc_stronghold_eye_mismatch | 1 |
| know_monogatari_homage | 0.5 |
| know_shenzhen_qianhai | 1 |
| understand_oreapo_fanart_details | 0.94 |

## 元信息

- run_id: `2026-10-11T08-01-31`
- duration_seconds: `121.01`
- cache: hits `0`, misses `42`, writes `42`
- tokens gemini-3.8-flash-exp-a: input `12149`, output `27741`, reasoning `9783`
