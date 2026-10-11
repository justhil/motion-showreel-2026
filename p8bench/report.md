# p8bench Report

## 总览

| model | mean | errors | acg_knowledge | culture_knowledge | emotion_alignment | game | general_reasoning | geo_knowledge | image_detail | insight | language_reasoning | long_tail_knowledge | maths | subtle_attention | token_efficiency | vision | vision_reasoning | world_knowledge |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| gemini-3.8-flash-exp-a-high | 0.9167 | 0 | 1 | 1 | 1 | 1 | 1 | 0.5 | 1 | 0.5 | 1 | 0.9167 | 0.75 | 1 | 0.75 | 0.875 | 1 | 0.9375 |

## 明细

| task | gemini-3.8-flash-exp-a-high |
| --- | ---: |
| frp_tcp_meltdown | 1 |
| integration_by_substitution | 1 |
| know_aqua_friends | 1 |
| know_deco27_thanks_songs | 1 |
| know_ken_brennan | 1 |
| know_twitch_raid | 1 |
| subtle_lyrics_discovery | 1 |
| sym_sum | 0.5 |
| debug_mc_stronghold_eye_mismatch | 1 |
| know_monogatari_homage | 1 |
| know_shenzhen_qianhai | 0.5 |
| understand_oreapo_fanart_details | 1 |

## 元信息

- run_id: `2026-10-11T08-31-43`
- duration_seconds: `150.75`
- cache: hits `0`, misses `42`, writes `42`
- tokens gemini-3.8-flash-exp-a-high: input `12149`, output `69484`, reasoning `52837`
