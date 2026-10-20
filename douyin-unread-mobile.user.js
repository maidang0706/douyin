// ==UserScript==
// @name         抖音插件 2026-10-20 21:22 调整界面尺寸(大档近全屏·小档为屏幕一半)
// @namespace    com.workbuddy.douyin.unread.mobile
// @version      1.5.3
// @description  2026-10-20 21:22 调整界面两档尺寸比例：大界面为近全屏浮动卡(四周各留2%，只比手机屏小一点点)；小界面为手机屏的一半(四周各留25%，居中浮动)。右上角「缩小/放大」按钮一键切换。登录检测与扫描逻辑不变。打开已登录的 www.douyin.com 即可抓取关注账号未读视频。
// @author       WorkBuddy
// @match        https://m.douyin.com/*
// @match        https://www.douyin.com/*
// @match        https://*.douyin.com/*
// @grant        none
// @run-at       document-start
// ==/UserScript==

/*
 * 实现说明：
 *  - 本脚本运行在抖音网页的「主世界」，因此可以直接劫持页面自身的 window.fetch / XMLHttpRequest，
 *    从接口返回的 JSON 中提取视频（作者、文案、封面、链接、发布时间）。
 *  - 用 localStorage（带 DYUNREAD_ 前缀）记录已见过的视频 ID 与已读状态。
 *  - 「未读」= 被扫描到（关注账号近期发布的视频）且未标记已读的视频。
 *  - 浏览器运行时：进入已登录的抖音网页版(www.douyin.com)后，脚本自动扫描全部关注账号、
 *    统计每个账号的未读视频数，并自动同步抖音「观看历史」推算已读，全程无需在关注页下滑。
 *  - 仍保留「开始记录」（被动捕获当前页视频）与「扫描全部关注」「同步已读」按钮作为手动补充。
 *  - 界面为移动端优化的悬浮按钮 + 底部面板上滑。
 */
(function () {
  /* 注意：此处故意不使用 'use strict'。内置的 X-Bogus 模块依赖非严格模式下的全局赋值
     （如 jsvmp = function(){} 创建全局），与 Node 非严格环境一致；若加 'use strict'，
     模块初始化会抛 "jsvmp is not defined"，导致整个脚本崩溃、界面不显示。 */
  /* ---------------- X-Bogus 签名（修复「接口被签名拦截」） ----------------
   * 抖音网页版 /aweme/v1/web/ 系列接口必须带 X-Bogus 签名，否则服务器直接拒绝
   * （脚本此前报「接口可能被签名拦截」就是这个原因：直连 fetch 没带签名）。
   * 这里内置一份纯 JS 的 X-Bogus 实现，对「请求 query + 浏览器 UA」实时计算签名后
   * 追加到 URL。来源：公开逆向实现（luoyanhan/X-Bogus），仅用于本人已登录账号的本地抓取。
   */
  var XB_SIGN = (function () {

function _0x5cd844(e) {
    var b = {
        exports: {}
    };
    return e(b, b.exports), b.exports
}
jsvmp = function(e, b, a) {
    function f(e, b, a) {
        return (f = function() {
            if ("undefined" == typeof Reflect || !Reflect.construct || Reflect.construct.sham) return !1;
            if ("function" == typeof Proxy) return !0;
            try {
                return Date.prototype.toString.call(Reflect.construct(Date, [], function() {})), !0
            } catch (e) {
                return !1
            }
        }() ? Reflect.construct : function(e, b, a) {
            var f = [null];
            f.push.apply(f, b);
            var c = new(Function.bind.apply(e, f));
            return a && function(e, b) {
                (Object.setPrototypeOf || function(e, b) {
                    return e.__proto__ = b, e
                })(e, b)
            }(c, a.prototype), c
        }).apply(null, arguments)
    }

    function c(e) {
        return function(e) {
            if (Array.isArray(e)) {
                for (var b = 0, a = new Array(e.length); b < e.length; b++) a[b] = e[b];
                return a
            }
        }(e) || function(e) {
            if (Symbol.iterator in Object(e) || "[object Arguments]" === Object.prototype.toString.call(e)) return Array.from(e)
        }(e) || function() {
            throw new TypeError("Invalid attempt to spread non-iterable instance")
        }()
    }
    for (var r = [], t = 0, d = [], i = 0, n = function(e, b) {
            var a = e[b++],
                f = e[b],
                c = parseInt("" + a + f, 16);
            if (c >> 7 == 0) return [1, c];
            if (c >> 6 == 2) {
                var r = parseInt("" + e[++b] + e[++b], 16);
                return c &= 63, [2, r = (c <<= 8) + r]
            }
            if (c >> 6 == 3) {
                var t = parseInt("" + e[++b] + e[++b], 16),
                    d = parseInt("" + e[++b] + e[++b], 16);
                return c &= 63, [3, d = (c <<= 16) + (t <<= 8) + d]
            }
        }, s = function(e, b) {
            var a = parseInt("" + e[b] + e[b + 1], 16);
            return a > 127 ? -256 + a : a
        }, o = function(e, b) {
            var a = parseInt("" + e[b] + e[b + 1] + e[b + 2] + e[b + 3], 16);
            return a > 32767 ? -65536 + a : a
        }, l = function(e, b) {
            var a = parseInt("" + e[b] + e[b + 1] + e[b + 2] + e[b + 3] + e[b + 4] + e[b + 5] + e[b + 6] + e[b + 7], 16);
            return a > 2147483647 ? 0 + a : a
        }, _ = function(e, b) {
            return parseInt("" + e[b] + e[b + 1], 16)
        }, x = function(e, b) {
            return parseInt("" + e[b] + e[b + 1] + e[b + 2] + e[b + 3], 16)
        }, u = u || this || window, h = (e.length, 0), p = "", y = h; y < h + 16; y++) {
        var v = "" + e[y++] + e[y];
        v = parseInt(v, 16), p += String.fromCharCode(v)
    }
    if ("HNOJ@?RC" != p) throw new Error("error magic number " + p);
    parseInt("" + e[h += 16] + e[h + 1], 16), h += 8, t = 0;
    for (var g = 0; g < 4; g++) {
        var w = h + 2 * g,
            A = parseInt("" + e[w++] + e[w], 16);
        t += (3 & A) << 2 * g
    }
    h += 16;
    var C = parseInt("" + e[h += 8] + e[h + 1] + e[h + 2] + e[h + 3] + e[h + 4] + e[h + 5] + e[h + 6] + e[h + 7], 16),
        m = C,
        S = h += 8,
        z = x(e, h += C);
    z[1], h += 4, r = {
        p: [],
        q: []
    };
    for (var B = 0; B < z; B++) {
        for (var R = n(e, h), q = h += 2 * R[0], I = r.p.length, k = 0; k < R[1]; k++) {
            var j = n(e, q);
            r.p.push(j[1]), q += 2 * j[0]
        }
        h = q, r.q.push([I, r.p.length])
    }
    var O = {
            5: 1,
            6: 1,
            70: 1,
            22: 1,
            23: 1,
            37: 1,
            73: 1
        },
        U = {
            72: 1
        },
        D = {
            74: 1
        },
        N = {
            11: 1,
            12: 1,
            24: 1,
            26: 1,
            27: 1,
            31: 1
        },
        J = {
            10: 1
        },
        L = {
            2: 1,
            29: 1,
            30: 1,
            20: 1
        },
        T = [],
        E = [];

    function M(e, b, a) {
        for (var f = b; f < b + a;) {
            var c = _(e, f);
            T[f] = c, f += 2, U[c] ? (E[f] = s(e, f), f += 2) : O[c] ? (E[f] = o(e, f), f += 4) : D[c] ? (E[f] = l(e, f), f += 8) : N[c] ? (E[f] = _(e, f), f += 2) : J[c] ? (E[f] = x(e, f), f += 4) : L[c] && (E[f] = x(e, f), f += 4)
        }
    }
    return F(e, S, m / 2, [], b, a);

    function P(e, b, a, n, h, p, y, v) {
        null == p && (p = this);
        var g, w, A, C, m = [],
            S = 0;
        y && (w = y);
        var z, B, R = b,
            q = R + 2 * a;
        if (!v)
            for (; R < q;) {
                var I = parseInt("" + e[R] + e[R + 1], 16);
                R += 2;
                var j = 3 & (z = 13 * I % 241);
                if (z >>= 2, j < 1)
                    if (j = 3 & z, z >>= 2, j < 1) {
                        if ((j = z) < 1) return [1, m[S--]];
                        j < 5 ? (w = m[S--], m[S] = m[S] * w) : j < 7 ? (w = m[S--], m[S] = m[S] != w) : j < 14 ? (A = m[S--], C = m[S--], (j = m[S--]).x === P ? j.y >= 1 ? m[++S] = F(e, j.c, j.l, A, j.z, C, null, 1) : (m[++S] = F(e, j.c, j.l, A, j.z, C, null, 0), j.y++) : m[++S] = j.apply(C, A)) : j < 16 && (B = o(e, R), (g = function b() {
                            var a = arguments;
                            return b.y > 0 || b.y++, F(e, b.c, b.l, a, b.z, this, null, 0)
                        }).c = R + 4, g.l = B - 2, g.x = P, g.y = 0, g.z = h, m[S] = g, R += 2 * B - 2)
                    } else if (j < 2)(j = z) > 8 ? (w = m[S--], m[S] = typeof w) : j > 4 ? m[S -= 1] = m[S][m[S + 1]] : j > 2 && (A = m[S--], (j = m[S]).x === P ? j.y >= 1 ? m[S] = F(e, j.c, j.l, [A], j.z, C, null, 1) : (m[S] = F(e, j.c, j.l, [A], j.z, C, null, 0), j.y++) : m[S] = j(A));
                else if (j < 3) {
                    if ((j = z) < 9) {
                        for (w = m[S--], B = x(e, R), j = "", k = r.q[B][0]; k < r.q[B][1]; k++) j += String.fromCharCode(t ^ r.p[k]);
                        R += 4, m[S--][j] = w
                    } else if (j < 13) throw m[S--]
                } else(j = z) < 1 ? m[++S] = null : j < 3 ? (w = m[S--], m[S] = m[S] >= w) : j < 12 && (m[++S] = void 0);
                else if (j < 2)
                    if (j = 3 & z, z >>= 2, j < 1)
                        if ((j = z) < 5) {
                            B = o(e, R);
                            try {
                                if (d[i][2] = 1, 1 == (w = P(e, R + 4, B - 3, [], h, p, null, 0))[0]) return w
                            } catch (b) {
                                if (d[i] && d[i][1] && 1 == (w = P(e, d[i][1][0], d[i][1][1], [], h, p, b, 0))[0]) return w
                            } finally {
                                if (d[i] && d[i][0] && 1 == (w = P(e, d[i][0][0], d[i][0][1], [], h, p, null, 0))[0]) return w;
                                d[i] = 0, i--
                            }
                            R += 2 * B - 2
                        } else j < 7 ? (B = _(e, R), R += 2, m[S -= B] = 0 === B ? new m[S] : f(m[S], c(m.slice(S + 1, S + B + 1)))) : j < 9 && (w = m[S--], m[S] = m[S] & w);
                else if (j < 2)
                    if ((j = z) > 12) m[++S] = s(e, R), R += 2;
                    else if (j > 10) w = m[S--], m[S] = m[S] << w;
                else if (j > 8) {
                    for (B = x(e, R), j = "", k = r.q[B][0]; k < r.q[B][1]; k++) j += String.fromCharCode(t ^ r.p[k]);
                    R += 4, m[S] = m[S][j]
                } else j > 6 && (A = m[S--], w = delete m[S--][A]);
                else if (j < 3)(j = z) < 2 ? m[++S] = w : j < 11 ? (w = m[S -= 2][m[S + 1]] = m[S + 2], S--) : j < 13 && (w = m[S], m[++S] = w);
                else if ((j = z) > 12) m[++S] = p;
                else if (j > 5) w = m[S--], m[S] = m[S] !== w;
                else if (j > 3) w = m[S--], m[S] = m[S] / w;
                else if (j > 1) {
                    if ((B = o(e, R)) < 0) {
                        v = 1, M(e, b, 2 * a), R += 2 * B - 2;
                        break
                    }
                    R += 2 * B - 2
                } else j > -1 && (m[S] = !m[S]);
                else if (j < 3)
                    if (j = 3 & z, z >>= 2, j < 1)(j = z) > 13 ? (m[++S] = o(e, R), R += 4) : j > 11 ? (w = m[S--], m[S] = m[S] >> w) : j > 9 ? (B = _(e, R), R += 2, w = m[S--], h[B] = w) : j > 7 ? (B = x(e, R), R += 4, A = S + 1, m[S -= B - 1] = B ? m.slice(S, A) : []) : j > 0 && (w = m[S--], m[S] = m[S] > w);
                    else if (j < 2)(j = z) > 12 ? (w = m[S - 1], A = m[S], m[++S] = w, m[++S] = A) : j > 3 ? (w = m[S--], m[S] = m[S] == w) : j > 1 ? (w = m[S--], m[S] = m[S] + w) : j > -1 && (m[++S] = u);
                else if (j < 3) {
                    if ((j = z) > 13) m[++S] = !1;
                    else if (j > 6) w = m[S--], m[S] = m[S] instanceof w;
                    else if (j > 4) w = m[S--], m[S] = m[S] % w;
                    else if (j > 2)
                        if (m[S--]) R += 4;
                        else {
                            if ((B = o(e, R)) < 0) {
                                v = 1, M(e, b, 2 * a), R += 2 * B - 2;
                                break
                            }
                            R += 2 * B - 2
                        }
                    else if (j > 0) {
                        for (B = x(e, R), w = "", k = r.q[B][0]; k < r.q[B][1]; k++) w += String.fromCharCode(t ^ r.p[k]);
                        m[++S] = w, R += 4
                    }
                } else(j = z) > 7 ? (w = m[S--], m[S] = m[S] | w) : j > 5 ? (B = _(e, R), R += 2, m[++S] = h["$" + B]) : j > 3 && (B = o(e, R), d[i][0] && !d[i][2] ? d[i][1] = [R + 4, B - 3] : d[i++] = [0, [R + 4, B - 3], 0], R += 2 * B - 2);
                else if (j = 3 & z, z >>= 2, j > 2)(j = z) > 13 ? (m[++S] = l(e, R), R += 8) : j > 11 ? (w = m[S--], m[S] = m[S] >>> w) : j > 9 ? m[++S] = !0 : j > 7 ? (B = _(e, R), R += 2, m[S] = m[S][B]) : j > 0 && (w = m[S--], m[S] = m[S] < w);
                else if (j > 1)(j = z) > 10 ? (B = o(e, R), d[++i] = [
                    [R + 4, B - 3], 0, 0
                ], R += 2 * B - 2) : j > 8 ? (w = m[S--], m[S] = m[S] ^ w) : j > 6 && (w = m[S--]);
                else if (j > 0) {
                    if ((j = z) > 7) w = m[S--], m[S] = m[S] in w;
                    else if (j > 5) m[S] = ++m[S];
                    else if (j > 3) B = _(e, R), R += 2, w = h[B], m[++S] = w;
                    else if (j > 1) {
                        var O = 0,
                            U = m[S].length,
                            D = m[S];
                        m[++S] = function() {
                            var e = O < U;
                            if (e) {
                                var b = D[O++];
                                m[++S] = b
                            }
                            m[++S] = e
                        }
                    }
                } else if ((j = z) > 13) w = m[S], m[S] = m[S - 1], m[S - 1] = w;
                else if (j > 4) w = m[S--], m[S] = m[S] === w;
                else if (j > 2) w = m[S--], m[S] = m[S] - w;
                else if (j > 0) {
                    for (B = x(e, R), j = "", k = r.q[B][0]; k < r.q[B][1]; k++) j += String.fromCharCode(t ^ r.p[k]);
                    j = +j, R += 4, m[++S] = j
                }
            }
        if (v)
            for (; R < q;)
                if (I = T[R], R += 2, j = 3 & (z = 13 * I % 241), z >>= 2, j > 2)
                    if (j = 3 & z, z >>= 2, j > 2)(j = z) < 2 ? (w = m[S--], m[S] = m[S] < w) : j < 9 ? (B = E[R], R += 2, m[S] = m[S][B]) : j < 11 ? m[++S] = !0 : j < 13 ? (w = m[S--], m[S] = m[S] >>> w) : j < 15 && (m[++S] = E[R], R += 8);
                    else if (j > 1)(j = z) < 6 || (j < 8 ? w = m[S--] : j < 10 ? (w = m[S--], m[S] = m[S] ^ w) : j < 12 && (B = E[R], d[++i] = [
            [R + 4, B - 3], 0, 0
        ], R += 2 * B - 2));
        else if (j > 0)(j = z) > 7 ? (w = m[S--], m[S] = m[S] in w) : j > 5 ? m[S] = ++m[S] : j > 3 ? (B = E[R], R += 2, w = h[B], m[++S] = w) : j > 1 && (O = 0, U = m[S].length, D = m[S], m[++S] = function() {
            var e = O < U;
            if (e) {
                var b = D[O++];
                m[++S] = b
            }
            m[++S] = e
        });
        else if ((j = z) < 2) {
            for (B = E[R], j = "", k = r.q[B][0]; k < r.q[B][1]; k++) j += String.fromCharCode(t ^ r.p[k]);
            j = +j, R += 4, m[++S] = j
        } else j < 4 ? (w = m[S--], m[S] = m[S] - w) : j < 6 ? (w = m[S--], m[S] = m[S] === w) : j < 15 && (w = m[S], m[S] = m[S - 1], m[S - 1] = w);
        else if (j > 1)
            if (j = 3 & z, z >>= 2, j < 1)(j = z) > 13 ? (m[++S] = E[R], R += 4) : j > 11 ? (w = m[S--], m[S] = m[S] >> w) : j > 9 ? (B = E[R], R += 2, w = m[S--], h[B] = w) : j > 7 ? (B = E[R], R += 4, A = S + 1, m[S -= B - 1] = B ? m.slice(S, A) : []) : j > 0 && (w = m[S--], m[S] = m[S] > w);
            else if (j < 2)(j = z) < 1 ? m[++S] = u : j < 3 ? (w = m[S--], m[S] = m[S] + w) : j < 5 ? (w = m[S--], m[S] = m[S] == w) : j < 14 && (w = m[S - 1], A = m[S], m[++S] = w, m[++S] = A);
        else if (j < 3) {
            if ((j = z) > 13) m[++S] = !1;
            else if (j > 6) w = m[S--], m[S] = m[S] instanceof w;
            else if (j > 4) w = m[S--], m[S] = m[S] % w;
            else if (j > 2) m[S--] ? R += 4 : R += 2 * (B = E[R]) - 2;
            else if (j > 0) {
                for (B = E[R], w = "", k = r.q[B][0]; k < r.q[B][1]; k++) w += String.fromCharCode(t ^ r.p[k]);
                m[++S] = w, R += 4
            }
        } else(j = z) > 7 ? (w = m[S--], m[S] = m[S] | w) : j > 5 ? (B = E[R], R += 2, m[++S] = h["$" + B]) : j > 3 && (B = E[R], d[i][0] && !d[i][2] ? d[i][1] = [R + 4, B - 3] : d[i++] = [0, [R + 4, B - 3], 0], R += 2 * B - 2);
        else if (j > 0)
            if (j = 3 & z, z >>= 2, j < 1) {
                if ((j = z) > 9);
                else if (j > 7) w = m[S--], m[S] = m[S] & w;
                else if (j > 5) B = E[R], R += 2, m[S -= B] = 0 === B ? new m[S] : f(m[S], c(m.slice(S + 1, S + B + 1)));
                else if (j > 3) {
                    B = E[R];
                    try {
                        if (d[i][2] = 1, 1 == (w = P(e, R + 4, B - 3, [], h, p, null, 0))[0]) return w
                    } catch (b) {
                        if (d[i] && d[i][1] && 1 == (w = P(e, d[i][1][0], d[i][1][1], [], h, p, b, 0))[0]) return w
                    } finally {
                        if (d[i] && d[i][0] && 1 == (w = P(e, d[i][0][0], d[i][0][1], [], h, p, null, 0))[0]) return w;
                        d[i] = 0, i--
                    }
                    R += 2 * B - 2
                }
            } else if (j < 2)
            if ((j = z) < 8) A = m[S--], w = delete m[S--][A];
            else if (j < 10) {
            for (B = E[R], j = "", k = r.q[B][0]; k < r.q[B][1]; k++) j += String.fromCharCode(t ^ r.p[k]);
            R += 4, m[S] = m[S][j]
        } else j < 12 ? (w = m[S--], m[S] = m[S] << w) : j < 14 && (m[++S] = E[R], R += 2);
        else j < 3 ? (j = z) < 2 ? m[++S] = w : j < 11 ? (w = m[S -= 2][m[S + 1]] = m[S + 2], S--) : j < 13 && (w = m[S], m[++S] = w) : (j = z) > 12 ? m[++S] = p : j > 5 ? (w = m[S--], m[S] = m[S] !== w) : j > 3 ? (w = m[S--], m[S] = m[S] / w) : j > 1 ? R += 2 * (B = E[R]) - 2 : j > -1 && (m[S] = !m[S]);
        else if (j = 3 & z, z >>= 2, j < 1) {
            if ((j = z) < 1) return [1, m[S--]];
            j < 5 ? (w = m[S--], m[S] = m[S] * w) : j < 7 ? (w = m[S--], m[S] = m[S] != w) : j < 14 ? (A = m[S--], C = m[S--], (j = m[S--]).x === P ? j.y >= 1 ? m[++S] = F(e, j.c, j.l, A, j.z, C, null, 1) : (m[++S] = F(e, j.c, j.l, A, j.z, C, null, 0), j.y++) : m[++S] = j.apply(C, A)) : j < 16 && (B = E[R], (g = function b() {
                var a = arguments;
                return b.y > 0 || b.y++, F(e, b.c, b.l, a, b.z, this, null, 0)
            }).c = R + 4, g.l = B - 2, g.x = P, g.y = 0, g.z = h, m[S] = g, R += 2 * B - 2)
        } else if (j < 2)(j = z) > 8 ? (w = m[S--], m[S] = typeof w) : j > 4 ? m[S -= 1] = m[S][m[S + 1]] : j > 2 && (A = m[S--], (j = m[S]).x === P ? j.y >= 1 ? m[S] = F(e, j.c, j.l, [A], j.z, C, null, 1) : (m[S] = F(e, j.c, j.l, [A], j.z, C, null, 0), j.y++) : m[S] = j(A));
        else if (j < 3) {
            if ((j = z) < 9) {
                for (w = m[S--], B = E[R], j = "", k = r.q[B][0]; k < r.q[B][1]; k++) j += String.fromCharCode(t ^ r.p[k]);
                R += 4, m[S--][j] = w
            } else if (j < 13) throw m[S--]
        } else(j = z) < 1 ? m[++S] = null : j < 3 ? (w = m[S--], m[S] = m[S] >= w) : j < 12 && (m[++S] = void 0);
        return [0, null]
    }

    function F(e, b, a, f, c, r, t, d) {
        null == r && (r = this), c && !c.d && (c.d = 0, c.$0 = c, c[1] = {});
        var i, n, s = {},
            o = s.d = c ? c.d + 1 : 0;
        for (s["$" + o] = s, n = 0; n < o; n++) s[i = "$" + n] = c[i];
        for (n = 0, o = s.length = f.length; n < o; n++) s[n] = f[n];
        return d && !T[b] && M(e, b, 2 * a), T[b] ? P(e, b, a, 0, s, r, null, 1)[1] : P(e, b, a, 0, s, r, null, 0)[1]
    }
};
var _0x397dc7 = "undefined" != typeof globalThis ? globalThis : void 0 !== window ? window : "undefined" != typeof global ? global : "undefined" != typeof self ? self : {},
    _0x124d1a = _0x5cd844(function(_0x770f81) {
        ! function() {
            var _0x250d36 = "input is invalid type",
                _0x4cfaee = !1,
                _0x1702f9 = {},
                _0x5ccbb3 = !_0x4cfaee && "object" == typeof self,
                _0x54d876 = !_0x1702f9.JS_MD5_NO_NODE_JS && "object" == typeof process && process.versions && process.versions.node,
                _0x185caf;
            _0x54d876 ? _0x1702f9 = _0x397dc7 : _0x5ccbb3 && (_0x1702f9 = self);
            var _0x17dcbf = !_0x1702f9.JS_MD5_NO_COMMON_JS && _0x770f81.exports,
                _0x554fed = !1,
                _0x2de28f = !_0x1702f9.JS_MD5_NO_ARRAY_BUFFER && "undefined" != typeof ArrayBuffer,
                _0x3a9a1b = ["0", "1", "2", "3", "4", "5", "6", "7", "8", "9", "a", "b", "c", "d", "e", "f"],
                _0x465562 = [128, 32768, 8388608, -2147483648],
                _0x20b37e = [0, 8, 16, 24],
                _0x323604 = ["hex", "array", "digest", "buffer", "arrayBuffer", "base64"],
                _0x2c185e = ["A", "B", "C", "D", "E", "F", "G", "H", "I", "J", "K", "L", "M", "N", "O", "P", "Q", "R", "S", "T", "U", "V", "W", "X", "Y", "Z", "a", "b", "c", "d", "e", "f", "g", "h", "i", "j", "k", "l", "m", "n", "o", "p", "q", "r", "s", "t", "u", "v", "w", "x", "y", "z", "0", "1", "2", "3", "4", "5", "6", "7", "8", "9", "+", "/"],
                _0x4b59e0 = [];
            if (_0x2de28f) {
                var _0x395837 = new ArrayBuffer(68);
                _0x185caf = new Uint8Array(_0x395837), _0x4b59e0 = new Uint32Array(_0x395837)
            }!_0x1702f9.JS_MD5_NO_NODE_JS && Array.isArray || (Array.isArray = function(e) {
                return "[object Array]" === Object.prototype.toString.call(e)
            }), _0x2de28f && (_0x1702f9.JS_MD5_NO_ARRAY_BUFFER_IS_VIEW || !ArrayBuffer.isView) && (ArrayBuffer.isView = function(e) {
                return "object" == typeof e && e.buffer && e.buffer.constructor === ArrayBuffer
            });
            var _0x4e9930 = function(e) {
                    return function(b) {
                        return new _0x5887c8(!0).update(b)[e]()
                    }
                },
                _0x38ba77 = function() {
                    var e = _0x4e9930("hex");
                    _0x54d876 && (e = _0x474989(e)), e.create = function() {
                        return new _0x5887c8
                    }, e.update = function(b) {
                        return e.create().update(b)
                    };
                    for (var b = 0; b < _0x323604.length; ++b) {
                        var a = _0x323604[b];
                        e[a] = _0x4e9930(a)
                    }
                    return e
                },
                _0x474989 = function(_0x57eeaa) {
                    var _0x114910, _0x226465 = eval("require('crypto');"),
                        _0x1f6ae0 = eval("require('buffer')['Buffer'];");
                    return function(e) {
                        if ("string" == typeof e) return _0x226465.createHash("md5").update(e, "utf8").digest("hex");
                        if (null == e) throw _0x250d36;
                        return e.constructor === ArrayBuffer && (e = new Uint8Array(e)), Array.isArray(e) || ArrayBuffer.isView(e) || e.constructor === _0x1f6ae0 ? _0x226465.createHash("md5").update(new _0x1f6ae0.from(e)).digest("hex") : _0x57eeaa(e)
                    }
                };

            function _0x5887c8(e) {
                if (e) _0x4b59e0[0] = _0x4b59e0[16] = _0x4b59e0[1] = _0x4b59e0[2] = _0x4b59e0[3] = _0x4b59e0[4] = _0x4b59e0[5] = _0x4b59e0[6] = _0x4b59e0[7] = _0x4b59e0[8] = _0x4b59e0[9] = _0x4b59e0[10] = _0x4b59e0[11] = _0x4b59e0[12] = _0x4b59e0[13] = _0x4b59e0[14] = _0x4b59e0[15] = 0, this.blocks = _0x4b59e0, this.buffer8 = _0x185caf;
                else if (_0x2de28f) {
                    var b = new ArrayBuffer(68);
                    this.buffer8 = new Uint8Array(b), this.blocks = new Uint32Array(b)
                } else this.blocks = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
                this.h0 = this.h1 = this.h2 = this.h3 = this.start = this.bytes = this.hBytes = 0, this.finalized = this.hashed = !1, this.first = !0
            }
            _0x5887c8.prototype.update = function(e) {
                if (!this.finalized) {
                    var b, a = typeof e;
                    if ("string" !== a) {
                        if ("object" !== a || null === e) throw _0x250d36;
                        if (_0x2de28f && e.constructor === ArrayBuffer) e = new Uint8Array(e);
                        else if (!(Array.isArray(e) || _0x2de28f && ArrayBuffer.isView(e))) throw _0x250d36;
                        b = !0
                    }
                    for (var f, c, r = 0, t = e.length, d = this.blocks, i = this.buffer8; r < t;) {
                        if (this.hashed && (this.hashed = !1, d[0] = d[16], d[16] = d[1] = d[2] = d[3] = d[4] = d[5] = d[6] = d[7] = d[8] = d[9] = d[10] = d[11] = d[12] = d[13] = d[14] = d[15] = 0), b)
                            if (_0x2de28f)
                                for (c = this.start; r < t && c < 64; ++r) i[c++] = e[r];
                            else
                                for (c = this.start; r < t && c < 64; ++r) d[c >> 2] |= e[r] << _0x20b37e[3 & c++];
                        else if (_0x2de28f)
                            for (c = this.start; r < t && c < 64; ++r)(f = e.charCodeAt(r)) < 128 ? i[c++] = f : f < 2048 ? (i[c++] = 192 | f >> 6, i[c++] = 128 | 63 & f) : f < 55296 || f >= 57344 ? (i[c++] = 224 | f >> 12, i[c++] = 128 | f >> 6 & 63, i[c++] = 128 | 63 & f) : (f = 65536 + ((1023 & f) << 10 | 1023 & e.charCodeAt(++r)), i[c++] = 240 | f >> 18, i[c++] = 128 | f >> 12 & 63, i[c++] = 128 | f >> 6 & 63, i[c++] = 128 | 63 & f);
                        else
                            for (c = this.start; r < t && c < 64; ++r)(f = e.charCodeAt(r)) < 128 ? d[c >> 2] |= f << _0x20b37e[3 & c++] : f < 2048 ? (d[c >> 2] |= (192 | f >> 6) << _0x20b37e[3 & c++], d[c >> 2] |= (128 | 63 & f) << _0x20b37e[3 & c++]) : f < 55296 || f >= 57344 ? (d[c >> 2] |= (224 | f >> 12) << _0x20b37e[3 & c++], d[c >> 2] |= (128 | f >> 6 & 63) << _0x20b37e[3 & c++], d[c >> 2] |= (128 | 63 & f) << _0x20b37e[3 & c++]) : (f = 65536 + ((1023 & f) << 10 | 1023 & e.charCodeAt(++r)), d[c >> 2] |= (240 | f >> 18) << _0x20b37e[3 & c++], d[c >> 2] |= (128 | f >> 12 & 63) << _0x20b37e[3 & c++], d[c >> 2] |= (128 | f >> 6 & 63) << _0x20b37e[3 & c++], d[c >> 2] |= (128 | 63 & f) << _0x20b37e[3 & c++]);
                        this.lastByteIndex = c, this.bytes += c - this.start, c >= 64 ? (this.start = c - 64, this.hash(), this.hashed = !0) : this.start = c
                    }
                    return this.bytes > 4294967295 && (this.hBytes += this.bytes / 4294967296 << 0, this.bytes = this.bytes % 4294967296), this
                }
            }, _0x5887c8.prototype.finalize = function() {
                if (!this.finalized) {
                    this.finalized = !0;
                    var e = this.blocks,
                        b = this.lastByteIndex;
                    e[b >> 2] |= _0x465562[3 & b], b >= 56 && (this.hashed || this.hash(), e[0] = e[16], e[16] = e[1] = e[2] = e[3] = e[4] = e[5] = e[6] = e[7] = e[8] = e[9] = e[10] = e[11] = e[12] = e[13] = e[14] = e[15] = 0), e[14] = this.bytes << 3, e[15] = this.hBytes << 3 | this.bytes >>> 29, this.hash()
                }
            }, _0x5887c8.prototype.hash = function() {
                var e, b, a, f, c, r, t = this.blocks;
                this.first ? b = ((b = ((e = ((e = t[0] - 680876937) << 7 | e >>> 25) - 271733879 << 0) ^ (a = ((a = (-271733879 ^ (f = ((f = (-1732584194 ^ 2004318071 & e) + t[1] - 117830708) << 12 | f >>> 20) + e << 0) & (-271733879 ^ e)) + t[2] - 1126478375) << 17 | a >>> 15) + f << 0) & (f ^ e)) + t[3] - 1316259209) << 22 | b >>> 10) + a << 0 : (e = this.h0, b = this.h1, a = this.h2, b = ((b += ((e = ((e += ((f = this.h3) ^ b & (a ^ f)) + t[0] - 680876936) << 7 | e >>> 25) + b << 0) ^ (a = ((a += (b ^ (f = ((f += (a ^ e & (b ^ a)) + t[1] - 389564586) << 12 | f >>> 20) + e << 0) & (e ^ b)) + t[2] + 606105819) << 17 | a >>> 15) + f << 0) & (f ^ e)) + t[3] - 1044525330) << 22 | b >>> 10) + a << 0), b = ((b += ((e = ((e += (f ^ b & (a ^ f)) + t[4] - 176418897) << 7 | e >>> 25) + b << 0) ^ (a = ((a += (b ^ (f = ((f += (a ^ e & (b ^ a)) + t[5] + 1200080426) << 12 | f >>> 20) + e << 0) & (e ^ b)) + t[6] - 1473231341) << 17 | a >>> 15) + f << 0) & (f ^ e)) + t[7] - 45705983) << 22 | b >>> 10) + a << 0, b = ((b += ((e = ((e += (f ^ b & (a ^ f)) + t[8] + 1770035416) << 7 | e >>> 25) + b << 0) ^ (a = ((a += (b ^ (f = ((f += (a ^ e & (b ^ a)) + t[9] - 1958414417) << 12 | f >>> 20) + e << 0) & (e ^ b)) + t[10] - 42063) << 17 | a >>> 15) + f << 0) & (f ^ e)) + t[11] - 1990404162) << 22 | b >>> 10) + a << 0, b = ((b += ((e = ((e += (f ^ b & (a ^ f)) + t[12] + 1804603682) << 7 | e >>> 25) + b << 0) ^ (a = ((a += (b ^ (f = ((f += (a ^ e & (b ^ a)) + t[13] - 40341101) << 12 | f >>> 20) + e << 0) & (e ^ b)) + t[14] - 1502002290) << 17 | a >>> 15) + f << 0) & (f ^ e)) + t[15] + 1236535329) << 22 | b >>> 10) + a << 0, b = ((b += ((f = ((f += (b ^ a & ((e = ((e += (a ^ f & (b ^ a)) + t[1] - 165796510) << 5 | e >>> 27) + b << 0) ^ b)) + t[6] - 1069501632) << 9 | f >>> 23) + e << 0) ^ e & ((a = ((a += (e ^ b & (f ^ e)) + t[11] + 643717713) << 14 | a >>> 18) + f << 0) ^ f)) + t[0] - 373897302) << 20 | b >>> 12) + a << 0, b = ((b += ((f = ((f += (b ^ a & ((e = ((e += (a ^ f & (b ^ a)) + t[5] - 701558691) << 5 | e >>> 27) + b << 0) ^ b)) + t[10] + 38016083) << 9 | f >>> 23) + e << 0) ^ e & ((a = ((a += (e ^ b & (f ^ e)) + t[15] - 660478335) << 14 | a >>> 18) + f << 0) ^ f)) + t[4] - 405537848) << 20 | b >>> 12) + a << 0, b = ((b += ((f = ((f += (b ^ a & ((e = ((e += (a ^ f & (b ^ a)) + t[9] + 568446438) << 5 | e >>> 27) + b << 0) ^ b)) + t[14] - 1019803690) << 9 | f >>> 23) + e << 0) ^ e & ((a = ((a += (e ^ b & (f ^ e)) + t[3] - 187363961) << 14 | a >>> 18) + f << 0) ^ f)) + t[8] + 1163531501) << 20 | b >>> 12) + a << 0, b = ((b += ((f = ((f += (b ^ a & ((e = ((e += (a ^ f & (b ^ a)) + t[13] - 1444681467) << 5 | e >>> 27) + b << 0) ^ b)) + t[2] - 51403784) << 9 | f >>> 23) + e << 0) ^ e & ((a = ((a += (e ^ b & (f ^ e)) + t[7] + 1735328473) << 14 | a >>> 18) + f << 0) ^ f)) + t[12] - 1926607734) << 20 | b >>> 12) + a << 0, b = ((b += ((r = (f = ((f += ((c = b ^ a) ^ (e = ((e += (c ^ f) + t[5] - 378558) << 4 | e >>> 28) + b << 0)) + t[8] - 2022574463) << 11 | f >>> 21) + e << 0) ^ e) ^ (a = ((a += (r ^ b) + t[11] + 1839030562) << 16 | a >>> 16) + f << 0)) + t[14] - 35309556) << 23 | b >>> 9) + a << 0, b = ((b += ((r = (f = ((f += ((c = b ^ a) ^ (e = ((e += (c ^ f) + t[1] - 1530992060) << 4 | e >>> 28) + b << 0)) + t[4] + 1272893353) << 11 | f >>> 21) + e << 0) ^ e) ^ (a = ((a += (r ^ b) + t[7] - 155497632) << 16 | a >>> 16) + f << 0)) + t[10] - 1094730640) << 23 | b >>> 9) + a << 0, b = ((b += ((r = (f = ((f += ((c = b ^ a) ^ (e = ((e += (c ^ f) + t[13] + 681279174) << 4 | e >>> 28) + b << 0)) + t[0] - 358537222) << 11 | f >>> 21) + e << 0) ^ e) ^ (a = ((a += (r ^ b) + t[3] - 722521979) << 16 | a >>> 16) + f << 0)) + t[6] + 76029189) << 23 | b >>> 9) + a << 0, b = ((b += ((r = (f = ((f += ((c = b ^ a) ^ (e = ((e += (c ^ f) + t[9] - 640364487) << 4 | e >>> 28) + b << 0)) + t[12] - 421815835) << 11 | f >>> 21) + e << 0) ^ e) ^ (a = ((a += (r ^ b) + t[15] + 530742520) << 16 | a >>> 16) + f << 0)) + t[2] - 995338651) << 23 | b >>> 9) + a << 0, b = ((b += ((f = ((f += (b ^ ((e = ((e += (a ^ (b | ~f)) + t[0] - 198630844) << 6 | e >>> 26) + b << 0) | ~a)) + t[7] + 1126891415) << 10 | f >>> 22) + e << 0) ^ ((a = ((a += (e ^ (f | ~b)) + t[14] - 1416354905) << 15 | a >>> 17) + f << 0) | ~e)) + t[5] - 57434055) << 21 | b >>> 11) + a << 0, b = ((b += ((f = ((f += (b ^ ((e = ((e += (a ^ (b | ~f)) + t[12] + 1700485571) << 6 | e >>> 26) + b << 0) | ~a)) + t[3] - 1894986606) << 10 | f >>> 22) + e << 0) ^ ((a = ((a += (e ^ (f | ~b)) + t[10] - 1051523) << 15 | a >>> 17) + f << 0) | ~e)) + t[1] - 2054922799) << 21 | b >>> 11) + a << 0, b = ((b += ((f = ((f += (b ^ ((e = ((e += (a ^ (b | ~f)) + t[8] + 1873313359) << 6 | e >>> 26) + b << 0) | ~a)) + t[15] - 30611744) << 10 | f >>> 22) + e << 0) ^ ((a = ((a += (e ^ (f | ~b)) + t[6] - 1560198380) << 15 | a >>> 17) + f << 0) | ~e)) + t[13] + 1309151649) << 21 | b >>> 11) + a << 0, b = ((b += ((f = ((f += (b ^ ((e = ((e += (a ^ (b | ~f)) + t[4] - 145523070) << 6 | e >>> 26) + b << 0) | ~a)) + t[11] - 1120210379) << 10 | f >>> 22) + e << 0) ^ ((a = ((a += (e ^ (f | ~b)) + t[2] + 718787259) << 15 | a >>> 17) + f << 0) | ~e)) + t[9] - 343485551) << 21 | b >>> 11) + a << 0, this.first ? (this.h0 = e + 1732584193 << 0, this.h1 = b - 271733879 << 0, this.h2 = a - 1732584194 << 0, this.h3 = f + 271733878 << 0, this.first = !1) : (this.h0 = this.h0 + e << 0, this.h1 = this.h1 + b << 0, this.h2 = this.h2 + a << 0, this.h3 = this.h3 + f << 0)
            }, _0x5887c8.prototype.hex = function() {
                this.finalize();
                var e = this.h0,
                    b = this.h1,
                    a = this.h2,
                    f = this.h3;
                return _0x3a9a1b[e >> 4 & 15] + _0x3a9a1b[15 & e] + _0x3a9a1b[e >> 12 & 15] + _0x3a9a1b[e >> 8 & 15] + _0x3a9a1b[e >> 20 & 15] + _0x3a9a1b[e >> 16 & 15] + _0x3a9a1b[e >> 28 & 15] + _0x3a9a1b[e >> 24 & 15] + _0x3a9a1b[b >> 4 & 15] + _0x3a9a1b[15 & b] + _0x3a9a1b[b >> 12 & 15] + _0x3a9a1b[b >> 8 & 15] + _0x3a9a1b[b >> 20 & 15] + _0x3a9a1b[b >> 16 & 15] + _0x3a9a1b[b >> 28 & 15] + _0x3a9a1b[b >> 24 & 15] + _0x3a9a1b[a >> 4 & 15] + _0x3a9a1b[15 & a] + _0x3a9a1b[a >> 12 & 15] + _0x3a9a1b[a >> 8 & 15] + _0x3a9a1b[a >> 20 & 15] + _0x3a9a1b[a >> 16 & 15] + _0x3a9a1b[a >> 28 & 15] + _0x3a9a1b[a >> 24 & 15] + _0x3a9a1b[f >> 4 & 15] + _0x3a9a1b[15 & f] + _0x3a9a1b[f >> 12 & 15] + _0x3a9a1b[f >> 8 & 15] + _0x3a9a1b[f >> 20 & 15] + _0x3a9a1b[f >> 16 & 15] + _0x3a9a1b[f >> 28 & 15] + _0x3a9a1b[f >> 24 & 15]
            }, _0x5887c8.prototype.toString = _0x5887c8.prototype.hex, _0x5887c8.prototype.digest = function() {
                this.finalize();
                var e = this.h0,
                    b = this.h1,
                    a = this.h2,
                    f = this.h3;
                return [255 & e, e >> 8 & 255, e >> 16 & 255, e >> 24 & 255, 255 & b, b >> 8 & 255, b >> 16 & 255, b >> 24 & 255, 255 & a, a >> 8 & 255, a >> 16 & 255, a >> 24 & 255, 255 & f, f >> 8 & 255, f >> 16 & 255, f >> 24 & 255]
            }, _0x5887c8.prototype.array = _0x5887c8.prototype.digest, _0x5887c8.prototype.arrayBuffer = function() {
                this.finalize();
                var e = new ArrayBuffer(16),
                    b = new Uint32Array(e);
                return b[0] = this.h0, b[1] = this.h1, b[2] = this.h2, b[3] = this.h3, e
            }, _0x5887c8.prototype.buffer = _0x5887c8.prototype.arrayBuffer, _0x5887c8.prototype.base64 = function() {
                for (var e, b, a, f = "", c = this.array(), r = 0; r < 15;) e = c[r++], b = c[r++], a = c[r++], f += _0x2c185e[e >>> 2] + _0x2c185e[63 & (e << 4 | b >>> 4)] + _0x2c185e[63 & (b << 2 | a >>> 6)] + _0x2c185e[63 & a];
                return f + (_0x2c185e[(e = c[r]) >>> 2] + _0x2c185e[e << 4 & 63] + "==")
            };
            var _0x4dd781 = _0x38ba77();
            _0x17dcbf ? _0x770f81.exports = _0x4dd781 : (_0x1702f9.md5 = _0x4dd781, _0x554fed && (void 0)(function() {
                return _0x4dd781
            }))
        }()
    });

function _0x178cef(e) {
    return jsvmp("484e4f4a403f52430038001eab0015840e8ee21a00000000000000621b000200001d000146000306000e271f001b000200021d00010500121b001b000b021b000b04041d0001071b000b0500000003000126207575757575757575757575757575757575757575757575757575757575757575", [, , void 0 !== _0x124d1a ? _0x124d1a : void 0, _0x178cef, e])
}
for (var _0xb55f3e = {
        boe: !1,
        aid: 0,
        dfp: !1,
        sdi: !1,
        enablePathList: [],
        _enablePathListRegex: [],
        urlRewriteRules: [],
        _urlRewriteRules: [],
        initialized: !1,
        enableTrack: !1,
        track: {
            unitTime: 0,
            unitAmount: 0,
            fre: 0
        },
        triggerUnload: !1,
        region: "",
        regionConf: {},
        umode: 0,
        v: !1,
        perf: !1,
        xxbg: !0
    }, _0x3eaf64 = {
        debug: function(e, b) {
            let a = !1;
            a = !1
        }
    }, _0x233455 = ["0", "1", "2", "3", "4", "5", "6", "7", "8", "9", "a", "b", "c", "d", "e", "f"], _0x2e9f6d = [], _0x511f86 = [], _0x3d35de = 0; _0x3d35de < 256; _0x3d35de++) _0x2e9f6d[_0x3d35de] = _0x233455[_0x3d35de >> 4 & 15] + _0x233455[15 & _0x3d35de], _0x3d35de < 16 && (_0x3d35de < 10 ? _0x511f86[48 + _0x3d35de] = _0x3d35de : _0x511f86[87 + _0x3d35de] = _0x3d35de);
var _0x2ce54d = function(e) {
        for (var b = e.length, a = "", f = 0; f < b;) a += _0x2e9f6d[e[f++]];
        return a
    },
    _0x5960a2 = function(e) {
        for (var b = e.length >> 1, a = b << 1, f = new Uint8Array(b), c = 0, r = 0; r < a;) f[c++] = _0x511f86[e.charCodeAt(r++)] << 4 | _0x511f86[e.charCodeAt(r++)];
        return f
    },
    _0x4e46b6 = {
        encode: _0x2ce54d,
        decode: _0x5960a2
    };

function sign(e, b) {
    return jsvmp("484e4f4a403f5243001f240fbf2031ccf317480300000000000007181b0002012e1d00921b000b171b000b02402217000a1c1b000b1726402217000c1c1b000b170200004017002646000306000e271f001b000200021d00920500121b001b000b031b000b17041d0092071b000b041e012f17000d1b000b05260a0000101c1b000b06260a0000101c1b001b000b071e01301d00931b001b000b081e00081d00941b0048021d00951b001b000b1b1d00961b0048401d009e1b001b000b031b000b16041d009f1b001b000b09221e0131241b000b031b000b09221e0131241b000b1e0a000110040a0001101d00d51b001b000b09221e0131241b000b031b000b09221e0131241b000b180a000110040a0001101d00d71b001b000b0a1e00101d00d91b001b000b0b261b000b1a1b000b190a0002101d00db1b001b000b0c261b000b221b000b210a0002101d00dc1b001b000b0d261b000b230200200a0002101d00dd1b001b000b09221e0131241b000b031b000b24040a0001101d00df1b001b000b0e1a00221e00de240a0000104903e82b1d00e31b001b000b0f260a0000101d00e41b001b000b1d1d00e71b001b000b1a4901002b1d00e81b001b000b1a4901002c1d00ea1b001b000b191d00f21b001b000b1f480e191d00f81b001b000b1f480f191d00f91b001b000b20480e191d00fb1b001b000b20480f191d00fe1b001b000b25480e191d01001b001b000b25480f191d01011b001b000b264818344900ff2f1d01031b001b000b264810344900ff2f1d01321b001b000b264808344900ff2f1d01331b001b000b264800344900ff2f1d01341b001b000b274818344900ff2f1d01351b001b000b274810344900ff2f1d01361b001b000b274808344900ff2f1d01371b001b000b274800344900ff2f1d01381b001b000b281b000b29311b000b2a311b000b2b311b000b2c311b000b2d311b000b2e311b000b2f311b000b30311b000b31311b000b32311b000b33311b000b34311b000b35311b000b36311b000b37311b000b38311b000b39311d01391b004900ff1d013a1b001b000b10261b000b281b000b2a1b000b2c1b000b2e1b000b301b000b321b000b341b000b361b000b381b000b3a1b000b291b000b2b1b000b2d1b000b2f1b000b311b000b331b000b351b000b371b000b390a0013101d013b1b001b000b0c261b000b111b000b3b041b000b3c0a0002101d013c1b001b000b12261b000b1c1b000b3b1b000b3d0a0003101d013d1b001b000b13261b000b3e0200240a0002101d013e1b000b3f0000013f000126207575757575757575757575757575757575757575757575757575757575757575012b0e7776757a7d7643617c637661676a027a77065c717976706708777671667474766107767d65707c77760374766707707c7d607c7f7607757a61767166740a7c66677661447a77677b0a7a7d7d7661447a77677b0b7c666776615b767a747b670b7a7d7d76615b767a747b6709666076615274767d670b677c5f7c64766150726076077a7d77766b5c7508767f767067617c7d09667d7776757a7d76770963617c677c676a637608677c4067617a7d740470727f7f0763617c7076606010487c71797670673363617c707660604e067c717976706705677a677f76047d7c7776012e0125012402602341525150575655545b5a59585f5e5d5c43424140474645444b4a49727170777675747b7a79787f7e7d7c63626160676665646b6a6923222120272625242b2a383c2e0260224157787763747b2749586042512b233c5e75656420254b5a22412126384446527f567a245d5f717c624a475c4366697e5579597d616a6b2a5b45547072406750762e0260214157787763747b2749586042512b233c5e75656420254b5a224121263e4446527f567a245d5f717c624a475c4366697e5579597d616a6b2a5b45547072406750762e02602041525150575655545b5a59585f5e5d5c43424140474645444b4a49727170777675747b7a79787f7e7d7c63626160676665646b6a6923222120272625242b2a3e4c2e012a022222067f767d74677b0a707b7261507c7776526702222306707b726152670f487c717976706733447a7d777c644e08577c70667e767d6712487c7179767067335d72657a7472677c614e057960777c7e10487c7179767067335b7a60677c616a4e07637f66747a7d60084c637b727d677c7e0b70727f7f437b727d677c7e0b4c4c7d7a747b677e726176055266777a7c1850727d65726041767d7776617a7d74507c7d67766b6721570964767177617a657661137476675c647d43617c637661676a5d727e7660097f727d74667274766006707b617c7e760761667d677a7e7607707c7d7d767067144c4c64767177617a6576614c7665727f66726776134c4c60767f767d7a667e4c7665727f667267761b4c4c64767177617a6576614c6070617a63674c75667d70677a7c7d174c4c64767177617a6576614c6070617a63674c75667d70154c4c64767177617a6576614c6070617a63674c757d134c4c756b77617a6576614c7665727f66726776124c4c77617a6576614c667d64617263637677154c4c64767177617a6576614c667d64617263637677114c4c77617a6576614c7665727f66726776144c4c60767f767d7a667e4c667d64617263637677144c4c756b77617a6576614c667d64617263637677094c60767f767d7a667e0c70727f7f40767f767d7a667e164c40767f767d7a667e4c5a57564c4176707c6177766108777c70667e767d670478766a60057e7267707b06417674566b630a4f3748723e694e77704c067072707b764c04607c7e7608707675407b72616308507675407b72616305767c72637a16767c44767151617c64607661577a60637267707b76610f717a7d775c717976706752606a7d700e7a60565c44767151617c646076610120047c63767d0467766067097a7d707c747d7a677c077c7d7661617c6104707c77761242465c47524c564b5056565756574c5641410e607660607a7c7d40677c61727476076076675a67767e10607c7e7658766a5b766176516a6776770a61767e7c65765a67767e097a7d77766b767757510c437c7a7d6776615665767d670e5e40437c7a7d6776615665767d670d706176726776567f767e767d670670727d65726009677c5772677246415f076176637f727076034f603901740a7d72677a6576707c777614487c717976706733437f66747a7d526161726a4e4a4d7b676763602c294f3c4f3c3b48233e2a4e68223f206e3b4f3d48233e2a4e68223f206e3a68206e6f48723e75233e2a4e68223f276e3b2948723e75233e2a4e68223f276e3a68246e3a0127087f7c7072677a7c7d047b61767504757a7f76107b676763293c3c7f7c70727f7b7c606708637f7267757c617e02222102222007647a7d777c646002222703647a7d02222607727d77617c7a77022225057f7a7d666b022224067a637b7c7d7602222b047a63727702222a047a637c77022123037e7270022122097e72707a7d677c607b0c7e72704c637c64766163703a0470617c60036b22220570617a7c6005756b7a7c6004637a787602212102212002212702212602212502212402212b08757a6176757c6b3c067c637661723c05337c63613c05337c63673c07707b617c7e763c0867617a77767d673c047e607a7602212a0220230665767d777c6106547c7c747f760e4c637261727e40647a67707b5c7d0a777a61767067407a747d0a707c7d607a6067767d670660647a67707b03777c7e07637b727d677c7e047b7c7c7840525150575655545b5a59585f5e5d5c43424140474645444b4a49727170777675747b7a79787f7e7d7c63626160676665646b6a6923222120272625242b2a3e3d03727a77017d01750161096067726167477a7e7601670972717a7f7a677a76600a677a7e766067727e6322137b72617764726176507c7d70666161767d706a0c7776657a70765e767e7c616a087f727d74667274760a6176607c7f66677a7c7d0f7265727a7f4176607c7f66677a7c7d0960706176767d477c630a60706176767d5f767567107776657a7076437a6b767f4172677a7c0a63617c77667067406671077172676776616a016309677c66707b5a7d757c08677a7e76697c7d760a677a7e766067727e6321077463665a7d757c0b7960557c7d67605f7a60670b637f66747a7d605f7a60670a677a7e766067727e63200a76657661507c7c787a760767674c60707a77017e0b606a7d67726b5661617c610c7d72677a65765f767d74677b056167705a43097563457661607a7c7d0b4c4c657661607a7c7d4c4c08707f7a767d675a770a677a7e766067727e63270b766b67767d77557a767f77046366607b03727f7f04677b767d097172607625274c707b0c75617c7e507b7261507c7776067125274c2023022022087172607625274c23022021087172607625274c22022020087172607625274c2102202702202602202507747667477a7e760220240b777c7e5d7c6745727f7a77096066716067617a7d740863617c677c707c7f02202b02202a01230e222323232323232322222323232302272302272207757c616176727f02272104717c776a096067617a7d747a756a02686e0b717c776a45727f216067610a717c776a4c7b72607b2e01350366617f02272005626676616a0a72607c7f774c607a747d096372677b7d727e762e0967674c6476717a772e063566667a772e0227270227260e4c716a6776774c6076704c777a770227250a27212a272a2524212a25097576457661607a7c7d0227240e4c232151274925647c232323232202272b02272a05607f7a7076022623074056505a5d555c037d7c6409677a7e766067727e6305757f7c7c610661727d777c7e0f7476674747447671507c7c787a7660056767647a770867674c6476717a770767674476715a770b67674c6476717a774c65210967674476717a7745210761667d7d7a7d7405757f66607b087e7c65765f7a60670660637f7a70760671765e7c657609707f7a70785f7a6067077176507f7a70780c78766a717c7261775f7a60670a717658766a717c7261770b7270677a657640677267760b647a7d777c6440677267760360477e05676172707808667d7a67477a7e76037270700a667d7a67527e7c667d670871767b72657a7c61077e6074476a637603645a5707727a775f7a60670b63617a6572706a5e7c777606706660677c7e067260607a747d0f4456514c5756455a50564c5a5d555c0479607c7d0a6176747a7c7d507c7d75096176637c616746617f04766b7a67094b3e5e403e404746510c4b3e5e403e43524a5f5c525720232323232323232323232323232323232323232323232323232323232323232320772722772b70772a2b75232371212327762a2b23232a2a2b7670752b272124760165066671707c7776067776707c777602262202262102262002262702262602262502262402262b02262a022523022522022521022520", [, , void 0, void 0 !== _0x178cef ? _0x178cef : void 0, {
        boe: !1,
        aid: 0,
        dfp: !1,
        sdi: !1,
        enablePathList: [],
        _enablePathListRegex: [/\/web\/report/],
        urlRewriteRules: [],
        _urlRewriteRules: [],
        initialized: !1,
        enableTrack: !1,
        track: {
            unitTime: 0,
            unitAmount: 0,
            fre: 0
        },
        triggerUnload: !1,
        region: "",
        regionConf: {},
        umode: 0,
        v: !1,
        perf: !1,
        xxbg: !0
    }, () => 0, () => "03v", {
        ubcode: 0
    }, {
        bogusIndex: 0,
        msNewTokenList: [],
        moveList: [],
        clickList: [],
        keyboardList: [],
        activeState: [],
        aidList: [],
        envcode: 0,
        msToken: "",
        msStatus: 0,
        __ac_testid: "",
        ttwid: "",
        tt_webid: "",
        tt_webid_v2: ""
    }, void 0 !== _0x4e46b6 ? _0x4e46b6 : void 0, {
        userAgent: b
    }, (e, b) => {
        let a = new Uint8Array(3);
        return a[0] = e / 256, a[1] = e % 256, a[2] = b % 256, String.fromCharCode.apply(null, a)
    }, (e, b) => {
        let a, f = [],
            c = 0,
            r = "";
        for (let e = 0; e < 256; e++) f[e] = e;
        for (let b = 0; b < 256; b++) c = (c + f[b] + e.charCodeAt(b % e.length)) % 256, a = f[b], f[b] = f[c], f[c] = a;
        let t = 0;
        c = 0;
        for (let e = 0; e < b.length; e++) c = (c + f[t = (t + 1) % 256]) % 256, a = f[t], f[t] = f[c], f[c] = a, r += String.fromCharCode(b.charCodeAt(e) ^ f[(f[t] + f[c]) % 256]);
        return r
    }, (e, b) => jsvmp("484e4f4a403f524300281018f7b851f02d296e5b00000000000004a21b0002001d1d001e1b00131e00061a001d001f1b000b070200200200210d1b000b070200220200230d1b000b070200240200250d1b000b070200260200270d1b001b000b071b000b05191d00031b000200001d00281b0048001d00291b000b041e002a1b000b0b4803283b1700f11b001b000b04221e002b241b001e0029222d1b00241d00290a0001104900ff2f4810331b000b04221e002b241b001e0029222d1b00241d00290a0001104900ff2f480833301b000b04221e002b241b001e0029222d1b00241d00290a0001104900ff2f301d002c1b00220b091b000b08221e002d241b000b0a4a00fc00002f4812340a000110281d00281b00220b091b000b08221e002d241b000b0a4a0003f0002f480c340a000110281d00281b00220b091b000b08221e002d241b000b0a490fc02f4806340a000110281d00281b00220b091b000b08221e002d241b000b0a483f2f0a000110281d002816ff031b000b041e002a1b000b0b294800391700e01b001b000b04221e002b241b001e0029222d1b00241d00290a0001104900ff2f4810331b000b041e002a1b000b0b3917001e1b000b04221e002b241b000b0b0a0001104900ff2f4808331600054800301d002c1b00220b091b000b08221e002d241b000b0a4a00fc00002f4812340a000110281d00281b00220b091b000b08221e002d241b000b0a4a0003f0002f480c340a000110281d00281b00220b091b000b041e002a1b000b0b3917001e1b000b08221e002d241b000b0a490fc02f4806340a0001101600071b000b06281d00281b00220b091b000b06281d00281b000b090000002e000126207575757575757575757575757575757575757575757575757575757575757575012b0e7776757a7d7643617c637661676a027a77065c717976706708777671667474766107767d65707c77760374766707707c7d607c7f7607757a61767166740a7c66677661447a77677b0a7a7d7d7661447a77677b0b7c666776615b767a747b670b7a7d7d76615b767a747b6709666076615274767d670b677c5f7c64766150726076077a7d77766b5c7508767f767067617c7d09667d7776757a7d76770963617c677c676a637608677c4067617a7d740470727f7f0763617c7076606010487c71797670673363617c707660604e067c717976706705677a677f76047d7c7776012e0125012402602341525150575655545b5a59585f5e5d5c43424140474645444b4a49727170777675747b7a79787f7e7d7c63626160676665646b6a6923222120272625242b2a383c2e0260224157787763747b2749586042512b233c5e75656420254b5a22412126384446527f567a245d5f717c624a475c4366697e5579597d616a6b2a5b45547072406750762e0260214157787763747b2749586042512b233c5e75656420254b5a224121263e4446527f567a245d5f717c624a475c4366697e5579597d616a6b2a5b45547072406750762e02602041525150575655545b5a59585f5e5d5c43424140474645444b4a49727170777675747b7a79787f7e7d7c63626160676665646b6a6923222120272625242b2a3e4c2e012a022222067f767d74677b0a707b7261507c7776526702222306707b72615267", [, , , , e, b]), "undefined" != typeof Date ? Date : void 0, () => 0, (e, b, a, f, c, r, t, d, i, n, s, o, l, _, x, u, h, p, y) => {
        let v = new Uint8Array(19);
        return v[0] = e, v[1] = s, v[2] = b, v[3] = o, v[4] = a, v[5] = l, v[6] = f, v[7] = _, v[8] = c, v[9] = x, v[10] = r, v[11] = u, v[12] = t, v[13] = h, v[14] = d, v[15] = p, v[16] = i, v[17] = y, v[18] = n, String.fromCharCode.apply(null, v)
    }, e => String.fromCharCode(e), (e, b, a) => String.fromCharCode(e) + String.fromCharCode(b) + a, (e, b) => jsvmp("484e4f4a403f524300281018f7b851f02d296e5b00000000000004a21b0002001d1d001e1b00131e00061a001d001f1b000b070200200200210d1b000b070200220200230d1b000b070200240200250d1b000b070200260200270d1b001b000b071b000b05191d00031b000200001d00281b0048001d00291b000b041e002a1b000b0b4803283b1700f11b001b000b04221e002b241b001e0029222d1b00241d00290a0001104900ff2f4810331b000b04221e002b241b001e0029222d1b00241d00290a0001104900ff2f480833301b000b04221e002b241b001e0029222d1b00241d00290a0001104900ff2f301d002c1b00220b091b000b08221e002d241b000b0a4a00fc00002f4812340a000110281d00281b00220b091b000b08221e002d241b000b0a4a0003f0002f480c340a000110281d00281b00220b091b000b08221e002d241b000b0a490fc02f4806340a000110281d00281b00220b091b000b08221e002d241b000b0a483f2f0a000110281d002816ff031b000b041e002a1b000b0b294800391700e01b001b000b04221e002b241b001e0029222d1b00241d00290a0001104900ff2f4810331b000b041e002a1b000b0b3917001e1b000b04221e002b241b000b0b0a0001104900ff2f4808331600054800301d002c1b00220b091b000b08221e002d241b000b0a4a00fc00002f4812340a000110281d00281b00220b091b000b08221e002d241b000b0a4a0003f0002f480c340a000110281d00281b00220b091b000b041e002a1b000b0b3917001e1b000b08221e002d241b000b0a490fc02f4806340a0001101600071b000b06281d00281b00220b091b000b06281d00281b000b090000002e000126207575757575757575757575757575757575757575757575757575757575757575012b0e7776757a7d7643617c637661676a027a77065c717976706708777671667474766107767d65707c77760374766707707c7d607c7f7607757a61767166740a7c66677661447a77677b0a7a7d7d7661447a77677b0b7c666776615b767a747b670b7a7d7d76615b767a747b6709666076615274767d670b677c5f7c64766150726076077a7d77766b5c7508767f767067617c7d09667d7776757a7d76770963617c677c676a637608677c4067617a7d740470727f7f0763617c7076606010487c71797670673363617c707660604e067c717976706705677a677f76047d7c7776012e0125012402602341525150575655545b5a59585f5e5d5c43424140474645444b4a49727170777675747b7a79787f7e7d7c63626160676665646b6a6923222120272625242b2a383c2e0260224157787763747b2749586042512b233c5e75656420254b5a22412126384446527f567a245d5f717c624a475c4366697e5579597d616a6b2a5b45547072406750762e0260214157787763747b2749586042512b233c5e75656420254b5a224121263e4446527f567a245d5f717c624a475c4366697e5579597d616a6b2a5b45547072406750762e02602041525150575655545b5a59585f5e5d5c43424140474645444b4a49727170777675747b7a79787f7e7d7c63626160676665646b6a6923222120272625242b2a3e4c2e012a022222067f767d74677b0a707b7261507c7776526702222306707b72615267", [, , , , e, b]), , sign, e, void 0])
}

return sign;
  })();
  function getWebId() {
    const m = (document.cookie || '').match(/(?:^|;\s*)ttwid=([^;]+)/);
    return m ? decodeURIComponent(m[1]) : '';
  }
  function getMsToken() {
    const m = (document.cookie || '').match(/(?:^|;\s*)msToken=([^;]+)/);
    return m ? decodeURIComponent(m[1]) : '';
  }
  // 给任意抖音接口 URL 追加 X-Bogus 签名。
  // 重要修复：默认【不】强行补 webid / msToken。先前把 ttwid cookie 当作 webid 发给服务端，
  // 登录态下服务端会校验 webid 与 session 是否匹配，不匹配即返回 status_code=5(参数不合法)。
  // 因此默认只发 aid + X-Bogus 的最小请求；仅在调用方显式要求(opts.addWebid/addMsToken)时才补。
  function signUrl(url, opts) {
    opts = opts || {};
    try {
      const u = new URL(url);
      if (!u.searchParams.has('aid')) u.searchParams.set('aid', '6383');
      if (opts.addWebid !== false) {
        const wid = getWebId();
        if (wid && !u.searchParams.has('webid')) u.searchParams.set('webid', wid);
      }
      if (opts.addMsToken !== false) {
        const mt = getMsToken();
        if (mt && !u.searchParams.has('msToken')) u.searchParams.set('msToken', mt);
      }
      const query = u.search.slice(1); // 去掉前导 '?'
      const xb = XB_SIGN(query, navigator.userAgent || '');
      u.searchParams.set('X-Bogus', xb);
      return u.toString();
    } catch (e) {
      return url;
    }
  }

  // 统一的带签名请求：最小请求优先，失败再逐步补 webid / msToken 重试。
  // 返回 { ok, j, err, http }。ok=true 表示 status_code 为 0（或字段缺失视为成功）。
  async function signedFetch(pathAndQuery, { extra, tries } = {}) {
    if (!tries) tries = [
      { addWebid: false, addMsToken: false }, // 最小：仅 aid + X-Bogus（修复登录态 status_code=5）
      { addWebid: true,  addMsToken: false }, // 补 webid
      {}                                         // 补 webid + msToken
    ];
    const last = { ok: false, j: null, err: '', http: 0 };
    for (const t of tries) {
      let url = API + pathAndQuery;
      try {
        const u = new URL(url);
        if (extra) for (const k in extra) if (!u.searchParams.has(k)) u.searchParams.set(k, extra[k]);
        url = u.toString();
        const r = await fetch(signUrl(url, t), { credentials: 'include' });
        last.http = r.status;
        const j = await r.json().catch(function () { return null; });
        last.j = j;
        if (j && (!j.status_code || j.status_code === 0)) { last.ok = true; return last; }
        last.err = 'status_code=' + (j && j.status_code != null ? j.status_code : '?') + ' ' + ((j && j.status_msg) || '');
      } catch (e) {
        last.err = '请求异常：' + (e && e.message ? e.message : e);
        last.j = null;
      }
    }
    return last;
  }


  /* ---------------- 存储 ---------------- */
  const K_DATA = 'DYUNREAD_DATA_v1';
  const K_REC = 'DYUNREAD_REC_v1';
  const K_WATCHED = 'DYUNREAD_WATCHED_v1'; // 来自抖音「观看历史」的已看视频 ID 集合
  const K_UID = 'DYUNREAD_UID_v1';        // 被动捕获到的当前登录用户 uid（持久化，避免每次重新取）
  const K_SEC = 'DYUNREAD_SEC_v1';        // 当前登录用户 sec_uid
  let lastApiError = ''; // 最近一次接口失败原因，用于给出精准报错（而不是笼统的「接口未返回数据」）

  // 被动捕获到的当前用户 uid / sec_uid：抖音自己的页面代码在加载用户态时会调用 commit/user、
  // user/profile 等接口，响应里带当前用户 uid；我们用 fetch/XHR hook 把这些响应里的 uid 抓出来，
  // 比「主动调 commit/user」稳——后者在登录态下常被服务端校验拦成 status_code=5。
  let CAPTURED_UID = '';
  let CAPTURED_SEC = '';
  try { CAPTURED_UID = localStorage.getItem(K_UID) || ''; } catch (e) {}
  try { CAPTURED_SEC = localStorage.getItem(K_SEC) || ''; } catch (e) {}
  function storeSelf(uid, sec) {
    if (uid && /^\d{6,20}$/.test(String(uid))) { CAPTURED_UID = String(uid); try { localStorage.setItem(K_UID, CAPTURED_UID); } catch (e) {} }
    if (sec && /MS4w/i.test(String(sec))) { CAPTURED_SEC = String(sec); try { localStorage.setItem(K_SEC, CAPTURED_SEC); } catch (e) {} }
  }
  // 从一个接口响应里提取「当前用户」的 uid / sec_uid。
  // 只认顶层 user 对象（commit/user、user/profile/other 都返回 {user:{uid,sec_uid}}），
  // 绝不抓 feed 里每个作者的 uid，避免把别人当成自己。
  function extractSelfUid(data, url) {
    if (!data || typeof data !== 'object') return null;
    const u = data.user || data.user_info || data.userInfo;
    if (u && u.uid && /^\d{6,20}$/.test(String(u.uid))) return { uid: String(u.uid), sec: u.sec_uid || '' };
    if (u && u.uid_tt && /^\d{6,20}$/.test(String(u.uid_tt))) return { uid: String(u.uid_tt), sec: u.sec_uid || '' };
    return null;
  }

  function loadData() {
    try { return JSON.parse(localStorage.getItem(K_DATA)) || {}; }
    catch (e) { return {}; }
  }
  function saveData(d) {
    try { localStorage.setItem(K_DATA, JSON.stringify(d)); } catch (e) {}
  }
  function loadWatched() {
    try { return new Set(JSON.parse(localStorage.getItem(K_WATCHED)) || []); }
    catch (e) { return new Set(); }
  }
  function saveWatched(set) {
    try { localStorage.setItem(K_WATCHED, JSON.stringify(Array.from(set))); } catch (e) {}
  }
  function mergeWatched(ids) {
    if (!ids || !ids.length) return;
    const set = loadWatched();
    let changed = false;
    for (const id of ids) { if (!set.has(String(id))) { set.add(String(id)); changed = true; } }
    if (changed) { saveWatched(set); updateBadge(); if (panelOpen) render(); }
  }
  function isManualRecording() { return localStorage.getItem(K_REC) === '1'; }
  function setManualRecording(v) { localStorage.setItem(K_REC, v ? '1' : '0'); }

  function isFollowUrl() { return /follow|following/.test(location.href); }
  function shouldRecord() { return isFollowUrl() || isManualRecording(); }

  /* ---------------- 视频字段提取 ---------------- */
  function firstUrl(obj) {
    if (!obj) return '';
    if (typeof obj === 'string') return obj;
    if (Array.isArray(obj)) return obj[0] || '';
    const list = obj.url_list || obj.urlList || obj.origin_url_list || [];
    if (Array.isArray(list) && list.length) return list[0];
    return '';
  }
  function toVideo(a) {
    if (!a || typeof a !== 'object') return null;
    const id = String(a.aweme_id || a.awemeId || a.item_id || a.aweme_id_str || '');
    if (!id || id === '0') return null;
    const author = a.author || a.author_info || {};
    const video = a.video || {};
    const cover =
      firstUrl(video.cover) || firstUrl(video.origin_cover) ||
      firstUrl(video.dynamic_cover) || firstUrl(a.cover) || '';
    const desc = (a.desc || a.descr || a.caption || '').toString().trim();
    const authorName =
      author.nickname || author.nick_name || author.unique_id || author.short_id || '未知作者';
    const authorId = author.uid || author.sec_uid || author.unique_id || '';
    return {
      id: id,
      author: authorName,
      authorId: authorId,
      desc: desc,
      cover: cover,
      url: 'https://www.douyin.com/video/' + id,
      createTime: Number(a.create_time || a.createTime || Math.floor(Date.now() / 1000)),
    };
  }
  function collectAwemes(node, depth, out) {
    if (!node || out.length > 600) return;
    if (depth > 7) return;
    if (Array.isArray(node)) {
      for (let i = 0; i < node.length; i++) {
        const item = node[i];
        if (item && typeof item === 'object' && (item.aweme_id || item.awemeId || item.item_id)) {
          const v = toVideo(item);
          if (v) out.push(v);
        } else {
          collectAwemes(item, depth + 1, out);
        }
      }
    } else if (typeof node === 'object') {
      for (const k in node) {
        if (Object.prototype.hasOwnProperty.call(node, k)) collectAwemes(node[k], depth + 1, out);
      }
    }
  }
  function dedupe(videos) {
    const seen = new Set(); const res = [];
    for (const v of videos) { if (v && v.id && !seen.has(v.id)) { seen.add(v.id); res.push(v); } }
    return res;
  }
  // 递归收集响应里出现的所有 aweme_id（无论接口把视频套在 aweme_info / aweme_list 等任意层级）
  function collectIds(node, out) {
    if (!node || out.length > 6000) return;
    if (Array.isArray(node)) { for (let i = 0; i < node.length; i++) collectIds(node[i], out); return; }
    if (typeof node === 'object') {
      const id = node.aweme_id || node.awemeId || node.item_id || node.aweme_id_str;
      if (id && String(id) !== '0') { const s = String(id); if (out.indexOf(s) === -1) out.push(s); }
      for (const k in node) { if (Object.prototype.hasOwnProperty.call(node, k)) collectIds(node[k], out); }
    }
  }
  function parseAndCapture(data) {
    try {
      const raw = [];
      collectAwemes(data, 0, raw);
      const videos = dedupe(raw);
      if (videos.length) capture(videos);
    } catch (e) {}
  }

  /* ---------------- 记录 / 未读 ---------------- */
  function capture(videos, force) {
    if (!force && !shouldRecord()) return;
    const data = loadData();
    const now = Date.now();
    let added = 0;
    for (const v of videos) {
      if (!v || !v.id) continue;
      if (!data[v.id]) {
        data[v.id] = {
          id: v.id, author: v.author, authorId: v.authorId, desc: v.desc,
          cover: v.cover, url: v.url, createTime: v.createTime,
          cat: v.cat || '未分类',
          seenAt: now, read: false,
        };
        added++;
      }
    }
    if (added) { saveData(data); updateBadge(); if (panelOpen) render(); }
  }

  // 一个视频"已读" = 手动标记过 或 出现在抖音观看历史里
  function isRead(v) {
    if (v.read) return true;
    const set = loadWatched();
    return set.has(String(v.id));
  }
  function getUnread() {
    const data = loadData();
    return Object.values(data)
      .filter(function (v) { return !isRead(v); })
      .sort(function (a, b) { return (b.createTime || 0) - (a.createTime || 0); });
  }
  function markRead(id) {
    const data = loadData();
    if (data[id]) { data[id].read = true; data[id].readAt = Date.now(); }
    saveData(data); updateBadge(); render();
  }
  function markAllRead() {
    const data = loadData(); const now = Date.now();
    for (const k in data) { if (!data[k].read) { data[k].read = true; data[k].readAt = now; } }
    saveData(data); updateBadge(); render();
  }
  function clearRead() {
    const data = loadData(); const out = {};
    for (const k in data) { if (!isRead(data[k])) out[k] = data[k]; }
    saveData(out); updateBadge(); render();
  }

  // 账号标识：优先用 authorId，缺失时退化为 "n:" + 昵称
  function accKey(v) { return (v && v.authorId) ? v.authorId : ('n:' + (v.author || '未知作者')); }

  // 把某个账号的全部未读标记为已读
  function markAccountRead(key) {
    const data = loadData(); const now = Date.now();
    for (const k in data) { if (accKey(data[k]) === key) { data[k].read = true; if (!data[k].readAt) data[k].readAt = now; } }
    saveData(data); updateBadge(); render();
  }
  // 为某个账号设置/修改分类（同步到该账号下所有视频）
  function setAccountCat(key, cat) {
    const data = loadData(); const c = cat || '未分类';
    for (const k in data) { if (accKey(data[k]) === key) data[k].cat = c; }
    saveData(data); render();
  }

  /* ---------------- 接口劫持（主世界可直接 patch） ---------------- */
  function installFetchHook() {
    if (window.__dyMHook) return; window.__dyMHook = true;
    const orig = window.fetch ? window.fetch.bind(window) : null;
    if (!orig) return;
    window.fetch = function (input, init) {
      const p = orig(input, init);
      try {
        const url = typeof input === 'string' ? input : (input && input.url ? input.url : '');
        if (url && url.indexOf('douyin.com') !== -1) {
          p.then(function (resp) {
            try {
              const ct = resp.headers && resp.headers.get ? resp.headers.get('content-type') : '';
              if (ct && ct.indexOf('json') !== -1) {
                resp.clone().json().then(function (j) {
                  try {
                    // 被动抓取当前用户 uid（commit/user、user/profile/other 等响应顶层带 user）
                    const s = extractSelfUid(j, url);
                    if (s) storeSelf(s.uid, s.sec);
                    // 视频抓取（feed / aweme / following 等）
                    if (/history\/read/.test(url)) { const ids = []; collectIds(j, ids); mergeWatched(ids); }
                    else if (/feed|aweme|following|follow|recommend|refresh/.test(url)) { parseAndCapture(j); }
                  } catch (e) {}
                }).catch(function () {});
              }
            } catch (e) {}
          }).catch(function () {});
        }
      } catch (e) {}
      return p;
    };
  }
  function installXHRHook() {
    if (window.__dyMXHR) return; window.__dyMXHR = true;
    const Oo = XMLHttpRequest.prototype.open;
    const Os = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.open = function (m, u) { this.__u = typeof u === 'string' ? u : ''; return Oo.apply(this, arguments); };
    XMLHttpRequest.prototype.send = function () {
      this.addEventListener('load', function () {
        try {
          const url = this.__u || '';
          if (url && url.indexOf('douyin.com') !== -1) {
            const ct = this.getResponseHeader ? this.getResponseHeader('content-type') : '';
            if (ct && ct.indexOf('json') !== -1) {
              const j = JSON.parse(this.responseText);
              const s = extractSelfUid(j, url); if (s) storeSelf(s.uid, s.sec);
              if (/history\/read/.test(url)) { const ids = []; collectIds(j, ids); mergeWatched(ids); }
              else if (/feed|aweme|following|follow|recommend|refresh/.test(url)) { parseAndCapture(j); }
            }
          }
        } catch (e) {}
      });
      return Os.apply(this, arguments);
    };
  }

  /* ---------------- DOM 兜底扫描 ---------------- */
  function scanDOM() {
    if (!shouldRecord()) return;
    try {
      const anchors = document.querySelectorAll('a[href*="/video/"]');
      if (!anchors.length) return;
      const videos = [];
      anchors.forEach(function (a) {
        const href = a.getAttribute('href') || '';
        const m = href.match(/\/video\/(\d+)/);
        if (!m) return;
        const id = m[1];
        let card = a;
        for (let i = 0; i < 4 && card; i++) {
          if (card.classList && (card.classList.contains('video-card') || card.tagName === 'LI' || card.tagName === 'ARTICLE')) break;
          card = card.parentElement;
        }
        const img = a.querySelector('img') || (card ? card.querySelector('img') : null);
        let author = '未知作者';
        if (card) {
          const ae = card.querySelector('[class*="author"],[class*="nickname"],[class*="name"]');
          if (ae && ae.textContent) author = ae.textContent.trim().slice(0, 40);
        }
        videos.push({
          id: id, author: author, authorId: '',
          desc: (a.getAttribute('title') || a.textContent || '').trim().slice(0, 120),
          cover: img ? (img.getAttribute('src') || img.src || '') : '',
          url: 'https://www.douyin.com/video/' + id,
          createTime: Math.floor(Date.now() / 1000),
        });
      });
      capture(dedupe(videos));
    } catch (e) {}
  }

  /* ---------------- 全量扫描：枚举关注账号并逐个拉取视频 ---------------- */
  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  function setScanText(t) {
    const e = panel && panel.querySelector('#dyScanStatus');
    if (!e) return;
    const tx = e.querySelector('#dySStext');
    if (tx) tx.textContent = t;
    e.style.display = 'block';
  }
  // 一键复制文本（优先 clipboard API，失败回退 execCommand）
  function copyText(t) {
    if (t == null) t = '';
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(t).then(function () { flashCopied('已复制 ✓'); }, function () { fallbackCopy(t); });
        return;
      }
    } catch (e) {}
    fallbackCopy(t);
  }
  function fallbackCopy(t) {
    try {
      const ta = document.createElement('textarea');
      ta.value = t; ta.style.position = 'fixed'; ta.style.top = '-9999px'; ta.style.left = '0';
      document.body.appendChild(ta); ta.focus(); ta.select();
      const ok = document.execCommand('copy');
      document.body.removeChild(ta);
      flashCopied(ok ? '已复制 ✓' : '复制失败');
    } catch (e) { flashCopied('复制失败'); }
  }
  function flashCopied(msg) {
    const b = panel && panel.querySelector('#dySScopy');
    if (b) { b.textContent = msg || '已复制 ✓'; setTimeout(function () { b.textContent = '复制'; }, 1600); }
  }

  // 接口基础域名：必须与当前页面【同域】，否则浏览器会因跨域(CORS)直接拦截请求，
  // 表现为「接口未返回数据」。因此统一用 location.origin（当前页域名）。
  // 脚本启动时会确保运行在 www.douyin.com（见 ensureWww），这样接口请求永远同域。
  const API = location.origin;

  // 接口失败时的友好提示（按真实原因精准描述，而不是笼统的「接口未返回数据」）
  function apiFailHint(extra) {
    const cross = (function () { try { return new URL(API).host !== location.host; } catch (e) { return false; } })();
    let base;
    if (cross) {
      base = '当前页面(' + location.host + ')与接口域名(' + (function () { try { return new URL(API).host; } catch (e) { return '?'; } })() + ')跨域，浏览器会拦截请求。请确保在 www.douyin.com（桌面版网页）下使用本插件。';
    } else if (/douyin\.com/.test(location.hostname) && location.hostname !== 'www.douyin.com') {
      base = '当前在 ' + location.hostname + '（移动版），网页接口只存在于 www.douyin.com。请开启「桌面模式」访问 www.douyin.com 后刷新。';
    } else {
      base = '接口未返回数据。';
    }
    return base + (extra ? ('（' + extra + '）') : '');
  }
  // 确保运行在 www.douyin.com：网页接口只在 www 提供，且只有同域请求才不会被 CORS 拦截。
  // 若在 m.douyin.com 等子域，自动跳转一次到 www（登录 cookie 跨子域共享，不会掉登录）。
  function ensureWww() {
    const h = location.hostname;
    if (h === 'www.douyin.com' || h === 'douyin.com') return;
    if (localStorage.getItem('DYUNREAD_REDIRECTED') === '1') return; // 已尝试过，避免循环
    localStorage.setItem('DYUNREAD_REDIRECTED', '1');
    try { location.replace('https://www.douyin.com/'); } catch (e) {}
  }

  // 是否登录：优先用非 HttpOnly 登录票据判定；读不到（sessionid / sid_tt 多为 HttpOnly）时，
  // 在 douyin 域名下默认视为已登录，避免把「隐私隔离 / HttpOnly 读不到」误判成未登录。
  // 真正的未登录会由下方接口返回未授权来体现，不会卡在「未登录」。
  function isLoggedIn() {
    const c = document.cookie || '';
    if (/(^|;\s*)(sessionid|sessionid_ss|sid_tt|sid_guard|sid_ucp_v1|uid_tt|ttwid|odin_tt|passport_csrf_token|passport_auth_status)=/.test(c)) return true;
    if (/douyin\.com/.test(location.hostname)) return true; // douyin 域名下兜底默认已登录
    return false;
  }
  // 直接从 cookie 读取当前登录用户的 uid（零请求、最稳）。
  function getUidFromCookie() {
    const c = document.cookie || '';
    let m = c.match(/(?:^|;\s*)(?:uid_tt|uid_tt_ss|uid|sid_tt)=(\d+)/);
    if (m) return m[1];
    // passport_auth_status 形如 uid%3D123456%26uid_tt%3D...（部分站点把 uid 放在这里）
    m = c.match(/(?:^|;\s*)passport_auth_status=([^;]+)/);
    if (m) {
      try {
        const dec = decodeURIComponent(m[1]);
        const u = dec.match(/(?:^|&|%26)uid(?:_tt)?(?:%3D|=)(\d+)/);
        if (u) return u[1];
      } catch (e) {}
    }
    return '';
  }
  // 兜底：从页面内联 <script> JSON 里提取当前用户 uid。
  // 抖音的 uid_tt 多为 HttpOnly，JS 读不到；但登录后的 PC 网页会把当前用户 uid 写进页面内联脚本，
  // 桌面版扩展正是靠这一招拿到 uid（之前手机版缺失这一步，所以一直拿不到 uid → 登录检测失败）。
  function getUidFromPage() {
    try {
      // ① 内联 <script> 文本（桌面扩展靠这个拿到 uid）
      const scripts = document.querySelectorAll('script');
      for (let i = 0; i < scripts.length; i++) {
        const txt = scripts[i].textContent || '';
        if (!/[Uu]id|user/i.test(txt)) continue;
        const m = txt.match(/(?:user_id|uid|uid_tt|selfUserId|sec_uid)["'\s:]+("?\d{6,20}"?)/);
        if (m) {
          const v = m[1].replace(/"/g, '');
          if (/^\d{6,20}$/.test(v)) return v;
        }
      }
      // ② 页面全局状态（SPA 常把当前用户放进 window 全局对象，而不是内联 script 文本）
      const globals = [window.RENDER_DATA, window._ROUTER_DATA, window.__INITIAL_STATE__, window._INITIAL_STATE_, window.__NEXT_DATA__];
      for (let i = 0; i < globals.length; i++) {
        const s = extractSelfUid(globals[i]);
        if (s && s.uid) { storeSelf(s.uid, s.sec); return s.uid; }
      }
    } catch (e) {}
    return '';
  }
  function getNickFromPage() {
    try {
      const scripts = document.querySelectorAll('script');
      for (let i = 0; i < scripts.length; i++) {
        const txt = scripts[i].textContent || '';
        const m = txt.match(/"nickname"\s*:\s*"([^"]{1,30})"/);
        if (m) return m[1];
      }
    } catch (e) {}
    return '';
  }
  // 从整页 / 全局状态里找当前登录用户的 sec_uid（非数字，登录态下几乎一定存在；拿它去解析数字 uid）。
  function getSelfSecFromPage() {
    try {
      const globals = [window.RENDER_DATA, window._ROUTER_DATA, window.__INITIAL_STATE__, window._INITIAL_STATE_, window.__NEXT_DATA__];
      for (let i = 0; i < globals.length; i++) {
        const s = deepFindSec(globals[i]);
        if (s) return s;
      }
      const html = document.documentElement ? document.documentElement.innerHTML : '';
      const m = html.match(/sec_uid["'\s:]+"?(MS4w[^"]{10,60})/);
      if (m) return m[1];
    } catch (e) {}
    return '';
  }
  // 在对象树里找第一个 MS4w 开头的 sec_uid（登录态首页里当前用户态通常早于 feed 作者出现）
  function deepFindSec(obj) {
    if (!obj || typeof obj !== 'object') return '';
    const stack = [obj]; let n = 0;
    while (stack.length && n < 30000) {
      const o = stack.pop(); n++;
      if (Array.isArray(o)) { for (let i = 0; i < o.length; i++) { const x = o[i]; if (x && typeof x === 'object') stack.push(x); } continue; }
      if (typeof o.sec_uid === 'string' && /MS4w/.test(o.sec_uid)) return o.sec_uid;
      for (const k in o) { if (Object.prototype.hasOwnProperty.call(o, k)) { const v = o[k]; if (v && typeof v === 'object') stack.push(v); } }
    }
    return '';
  }
  // 用 sec_uid 解析出数字 uid（公开资料接口，登录态/非登录态一般都能返回目标用户的 uid）
  async function resolveUidBySec(sec) {
    try {
      const res = await signedFetch('/aweme/v1/web/user/profile/other/?aid=6383&sec_user_id=' + encodeURIComponent(sec), {});
      const j = res.j;
      if (res.ok && j) {
        const u = j.user || j.user_info || j.userInfo || (j.data && j.data.user);
        if (u && u.uid && /^\d{6,20}$/.test(String(u.uid))) return String(u.uid);
      }
    } catch (e) {}
    return '';
  }
  // 取当前登录用户 uid，优先级：
  // ① hook 已被动捕获（最稳，抖音自己的接口响应里带当前用户 uid）
  // ② cookie → ③ 页面内联/全局 → ④ 用页面 sec_uid 解析 → ⑤ 主动 commit/user（登录态可能返回 5，兜底）
  async function getMyUid() {
    if (CAPTURED_UID) return CAPTURED_UID;
    let uid = getUidFromCookie();
    if (uid) { storeSelf(uid, ''); return uid; }
    uid = getUidFromPage();
    if (uid) return uid;
    const sec = getSelfSecFromPage() || CAPTURED_SEC;
    if (sec) {
      const r = await resolveUidBySec(sec);
      if (r) { storeSelf(r, sec); return r; }
    }
    try {
      const r = await fetch(API + '/aweme/v1/web/commit/user/', { credentials: 'include' });
      const j = await r.json().catch(function () { return {}; });
      if (j && j.user && j.user.uid) { storeSelf(String(j.user.uid), j.user.sec_uid || ''); return String(j.user.uid); }
      lastApiError = 'commit/user status_code=' + (j && j.status_code) + ' ' + ((j && j.status_msg) || '');
    } catch (e) {
      lastApiError = 'commit/user 请求异常：' + (e && e.message ? e.message : e);
    }
    return '';
  }
  async function getFollowingList(myUid) {
    const out = [];
    let maxTime = 0;
    for (let page = 0; page < 40; page++) {
      let pq = '/aweme/v1/web/user/following/list/?aid=6383&count=50' +
        '&user_id=' + encodeURIComponent(myUid) + '&source_type=1';
      if (maxTime) pq += '&max_time=' + maxTime;
      const res = await signedFetch(pq, {});
      const j = res.j;
      if (!res.ok) { lastApiError = 'following/list ' + (res.err || ('HTTP ' + res.http)); break; }
      if (!j) { lastApiError = 'following/list 返回空/非 JSON'; break; }
      const list = (j && (j.following_list || j.followings)) || [];
      for (const a of list) { if (a && a.sec_uid) out.push({ sec_uid: a.sec_uid, nickname: a.nickname || a.unique_id || '未知' }); }
      if (!list.length) break;
      if (!(j.has_more || j.has_more === 1)) break;
      maxTime = j.max_time || (maxTime - 1);
    }
    return out;
  }
  async function getAccountPosts(secUid) {
    const out = [];
    let cursor = 0;
    for (let page = 0; page < 3; page++) {
      let pq = '/aweme/v1/web/aweme/post/?aid=6383&count=35' +
        '&sec_user_id=' + encodeURIComponent(secUid);
      if (cursor) pq += '&max_cursor=' + cursor;
      const res = await signedFetch(pq, {});
      const j = res.j;
      if (!res.ok) { lastApiError = 'post(' + (secUid || '').slice(0, 8) + '…) ' + (res.err || ('HTTP ' + res.http)); break; }
      if (!j) break;
      const arr = (j && (j.aweme_list || (j.aweme_info && j.aweme_info.aweme_list))) || [];
      for (const a of arr) { const v = toVideo(a); if (v) out.push(v); }
      if (!arr.length) break;
      cursor = j.max_cursor || 0;
      if (!cursor) break;
    }
    return out;
  }
  // —— 显式「登录检测」按钮：按 status_code 明确提示成功/失败及原因 ——
  async function checkLogin() {
    setScanText('⏳ 正在检测登录状态…');
    lastApiError = '';
    let myUid = await getMyUid();
    // 兜底：hook 可能正在从抖音自身的接口响应里被动捕获当前用户 uid，稍等几秒再试一次。
    if (!myUid) {
      for (let i = 0; i < 10 && !myUid; i++) {
        await sleep(400);
        if (CAPTURED_UID) myUid = CAPTURED_UID;
        else myUid = await getMyUid();
      }
    }
    if (myUid) {
      localStorage.setItem('DYUNREAD_LOGINED', '1');
      // 取昵称用于展示：优先从页面内联脚本提取（commit/user 在登录态下会被 webid 校验拦成 status_code=5）。
      let name = getNickFromPage();
      if (!name) {
        try {
          const r2 = await fetch(API + '/aweme/v1/web/commit/user/', { credentials: 'include' });
          const j2 = await r2.json().catch(function () { return {}; });
          name = (j2 && j2.user && (j2.user.nickname || j2.user.unique_id)) || '';
        } catch (e) {}
      }
      setScanText('✅ 登录成功' + (name ? ('，当前账号：' + name) : ('（uid ' + myUid + '）')) + '。现在可以点「扫描全部关注」了。');
      updateLoginUI();
    } else {
      const hint = isLoggedIn()
        ? '（检测到登录票据，但接口/页面均未取到账号信息；请刷新 www.douyin.com 页面后重试）'
        : '（未检测到登录票据，请先在 www.douyin.com 登录）';
      setScanText('❌ 登录检测失败。' + (lastApiError ? ('原因：' + lastApiError + '。') : '') + hint +
        ' 请确认：① 抖音网页版(www.douyin.com)右上角显示你的头像；② 用桌面版网页（非 m.douyin.com）。');
      updateLoginUI();
    }
  }

  async function runFullScanMobile() {
    setScanText('⏳ 正在校验登录…');
    const myUid = await getMyUid();
    if (!myUid) {
      const msg = isLoggedIn()
        ? ('⚠️ 接口未返回你的账号信息。' + (lastApiError ? ('原因：' + lastApiError + '。') : '') +
           '请先点「登录检测」确认已登录；若你在 m.douyin.com，请开启「桌面模式」访问 www.douyin.com 后刷新再试。')
        : ('⚠️ 检测到你尚未登录抖音，请先在 www.douyin.com 登录后再点扫描。');
      setScanText(msg);
      return;
    }
    localStorage.setItem('DYUNREAD_LOGINED', '1');
    updateLoginUI();
    const accounts = await getFollowingList(myUid);
    if (!accounts.length) {
      setScanText('⚠️ 未读取到关注账号。' + (lastApiError ? ('原因：' + lastApiError) : '（可能关注列表为空，或接口被限流，可稍后重试）'));
      return;
    }
    setScanText('⏳ 找到 ' + accounts.length + ' 个关注账号，开始逐个拉取…');
    let added = 0, failed = 0, scanned = 0;
    for (let i = 0; i < accounts.length; i++) {
      const acc = accounts[i];
      try {
        const vids = await getAccountPosts(acc.sec_uid);
        if (vids && vids.length) { capture(vids, true); added += vids.length; }
        scanned++;
      } catch (e) { failed++; }
      setScanText('⏳ 拉取：' + acc.nickname + '（' + (i + 1) + '/' + accounts.length + '，已抓 ' + added + ' 条，跳过 ' + failed + '）');
      await sleep(200);
    }
    // 自动同步观看历史，把已看的视频从「未读」中剔除
    setScanText('⏳ 同步观看历史（计算已读）…');
    try { await getWatchHistory(8); } catch (e) {}
    const unread = getUnread();
    setScanText('✅ 扫描完成：扫描 ' + scanned + ' 个账号，抓到 ' + added + ' 条视频，当前未读 ' + unread.length + ' 条。点开下方可看每个账号的未读数。');
    render();
    setTimeout(function () { setScanText(''); }, 8000);
  }

  /* ---------------- 自动流程：仅在点过「登录检测」且同域 www 下，才自动抓取 ---------------- */
  // runFullScanMobile 内部已包含「扫描关注账号 + 同步观看历史算已读」，这里直接复用。
  async function autoScanThenSync() {
    try {
      await runFullScanMobile();
    } catch (e) {
      // 后台自动扫描失败不打扰用户，可手动点「扫描全部关注」
    }
  }
  // 仅在用户显式登录过(DYUNREAD_LOGINED) 且处于 www.douyin.com 时，才自动触发一次（带 30 分钟冷却）
  function maybeAutoRun() {
    if (localStorage.getItem('DYUNREAD_LOGINED') !== '1') return;
    const h = location.hostname;
    if (h !== 'www.douyin.com' && h !== 'douyin.com') return;
    const now = Date.now();
    const COOLDOWN = 30 * 60 * 1000; // 30 分钟
    const last = Number(localStorage.getItem('DYUNREAD_AUTOSCAN_TS') || 0);
    if (now - last < COOLDOWN) return;
    localStorage.setItem('DYUNREAD_AUTOSCAN_TS', String(now));
    autoScanThenSync();
  }

  /* ---------------- 读取观看历史：用于推算"已读" ---------------- */
  async function getWatchHistory(maxPages) {
    if (!maxPages) maxPages = 80;
    setScanText('⏳ 正在读取观看历史…');
    const ids = [];
    let cursor = '0';
    for (let page = 0; page < maxPages; page++) {
      const pq = '/aweme/v1/web/history/read/?aid=6383&count=50&cursor=' + encodeURIComponent(cursor);
      const res = await signedFetch(pq, {});
      const j = res.j;
      if (!res.ok) {
        const cross = (function () { try { return new URL(API).host !== location.host; } catch (e) { return false; } })();
        setScanText('⚠️ 读取失败（' + (res.err || ('HTTP ' + res.http)) + '）。' + (cross ? '疑似跨域被浏览器拦截，请确保在 www.douyin.com 下使用。' : (isLoggedIn() ? '请确认已登录抖音网页版。' : '请先登录抖音。')));
        return;
      }
      if (!j) { setScanText('⚠️ 观看历史接口返回空/非 JSON。'); return; }
      const pageIds = [];
      collectIds(j, pageIds);
      for (const id of pageIds) if (ids.indexOf(id) === -1) ids.push(id);
      setScanText('⏳ 已读取观看历史 ' + ids.length + ' 条（第 ' + (page + 1) + ' 页）…');
      const hasMore = !!(j && (j.has_more === 1 || j.has_more === true));
      const next = j && (j.cursor !== undefined ? j.cursor : (j.data && j.data.cursor));
      if (!hasMore || next === undefined || String(next) === String(cursor)) break;
      cursor = String(next);
      await sleep(120);
    }
    mergeWatched(ids);
    setScanText('✅ 已同步观看历史：' + ids.length + ' 条已看视频（它们会从「未读」中消失）');
    render();
    setTimeout(function () { setScanText(''); }, 6000);
  }

  /* ---------------- 移动端 UI ---------------- */
  let panelOpen = false;
  let fab, panel, listEl, statusEl, badgeEl;

  const CSS = `
  #dyFab{position:fixed;right:14px;bottom:84px;width:56px;height:56px;border-radius:50%;
    background:#fe2c55;color:#fff;font-size:26px;line-height:56px;text-align:center;
    box-shadow:0 4px 14px rgba(0,0,0,.4);z-index:2147483646;cursor:pointer;user-select:none;
    border:2px solid rgba(255,255,255,.85);}
  #dyBadge{position:absolute;top:-4px;right:-4px;background:#fff;color:#fe2c55;font-size:12px;
    font-weight:700;border-radius:10px;min-width:20px;height:20px;line-height:20px;text-align:center;
    padding:0 5px;box-shadow:0 1px 3px rgba(0,0,0,.3);}
  /* 大界面：近全屏浮动卡（四周各留 2%，只比手机屏小一点点） */
  #dyPanel{position:fixed;left:2%;right:2%;top:2%;bottom:2%;background:#161823;color:#fff;
    border-radius:16px;z-index:2147483647;transform:translateY(110%);
    transition:transform .25s ease,left .2s ease,right .2s ease,top .2s ease,bottom .2s ease;display:flex;flex-direction:column;
    box-shadow:0 6px 26px rgba(0,0,0,.6);font-family:-apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif;font-size:14px;}
  #dyPanel.open{transform:translateY(0);}
  /* 小界面：手机屏的一半（四周各留 25%，居中浮动） */
  #dyPanel.small{left:25%;right:25%;top:25%;bottom:25%;}
  .dyHd{display:flex;align-items:center;justify-content:space-between;padding:14px 16px;
    border-bottom:1px solid #262a3b;}
  .dyHd b{font-size:17px;}
  .dyClose{font-size:22px;color:#9aa0b5;background:none;border:none;cursor:pointer;padding:0 6px;}
  .dySize{font-size:16px;font-weight:700;color:#9aa0b5;background:none;border:none;cursor:pointer;padding:0 10px;line-height:1;}
  .dySize:active{color:#fff;}
  .dyStatus{padding:10px 16px;font-size:14px;color:#9aa0b5;background:#1f2233;display:flex;
    align-items:center;justify-content:space-between;}
  .dyStatus .dot{display:inline-block;width:8px;height:8px;border-radius:50%;background:#666;margin-right:6px;vertical-align:middle;}
  .dyStatus .dot.on{background:#22c55e;}
  .dyList{flex:1;overflow-y:auto;padding:4px 14px 8px;-webkit-overflow-scrolling:touch;}
  .dyEmpty{text-align:center;opacity:.6;padding:40px 10px;line-height:1.8;font-size:14px;}
  .dyCard{display:flex;gap:10px;padding:10px 0;border-bottom:1px solid #262a3b;}
  .dyThumb{width:64px;height:84px;flex:0 0 64px;border-radius:8px;object-fit:cover;
    background:linear-gradient(135deg,#2a2d40,#3a3d52);}
  .dyPh{width:64px;height:84px;flex:0 0 64px;border-radius:8px;background:linear-gradient(135deg,#fe2c55,#f0385e);
    display:flex;align-items:center;justify-content:center;font-size:20px;color:#fff;}
  .dyMeta{flex:1;min-width:0;}
  .dyAuthor{font-weight:600;margin-bottom:3px;font-size:15px;}
  .dyDesc{font-size:13px;opacity:.8;line-height:1.5;display:-webkit-box;-webkit-line-clamp:2;
    -webkit-box-orient:vertical;overflow:hidden;margin-bottom:6px;}
  .dyTime{font-size:12px;opacity:.5;margin-bottom:6px;}
  .dyOpen{color:#fe2c55;font-size:13px;text-decoration:none;margin-right:14px;}
  .dyMk{color:#9aa0b5;font-size:13px;background:none;border:none;padding:0;cursor:pointer;}
  .dyMk:hover{color:#fff;}
  .dyFt{display:flex;flex-wrap:wrap;gap:12px;padding:14px;border-bottom:1px solid #262a3b;background:#1f2233;}
  .dyBtn{flex:1 1 calc(50% - 6px);min-width:0;border:none;border-radius:14px;padding:20px 10px;font-size:18px;font-weight:700;line-height:1.25;white-space:nowrap;cursor:pointer;
    background:#2a2d40;color:#fff;letter-spacing:.5px;}
  .dyBtn.primary{background:#fe2c55;}
  .dyBtn.ghost{background:transparent;border:2px solid #3a3d52;}
  .dySummary{padding:10px 16px;font-size:14px;color:#9aa0b5;background:#1f2233;border-bottom:1px solid #262a3b;}
  .dyScanStatus{padding:10px 16px;font-size:14px;color:#ffd166;background:#2a2d40;border-bottom:1px solid #262a3b;line-height:1.6;}
  .dyCatHd{padding:10px 16px;font-size:15px;font-weight:700;color:#fe2c55;background:#161823;position:sticky;top:0;z-index:1;border-bottom:1px solid #262a3b;}
  .dyAcc{border-bottom:1px solid #262a3b;}
  .dyAccHd{display:flex;align-items:center;gap:10px;padding:12px 16px;cursor:pointer;}
  .dyAvatar{width:38px;height:38px;border-radius:50%;background:#fe2c55;color:#fff;display:flex;align-items:center;justify-content:center;font-weight:700;flex:0 0 38px;font-size:16px;}
  .dyAccName{flex:1;font-weight:600;font-size:15px;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
  .dyAccCount{background:#fe2c55;color:#fff;border-radius:10px;padding:2px 10px;font-size:13px;font-weight:700;min-width:20px;text-align:center;}
  .dyAccActions{display:flex;gap:8px;}
  .dyMini{background:#2a2d40;color:#fff;border:none;border-radius:8px;padding:11px 16px;font-size:15px;font-weight:600;cursor:pointer;}
  .dyMini.cat{background:transparent;border:1px solid #3a3d52;color:#9aa0b5;}
  .dyAccBody{padding:0 14px 12px;}
  .dyThumbs{display:grid;grid-template-columns:repeat(4,1fr);gap:6px;}
  .dyThumbWrap{position:relative;display:block;border-radius:6px;overflow:hidden;background:#2a2d40;}
  .dyThumbWrap img{width:100%;aspect-ratio:3/4;object-fit:cover;display:block;}
  .dyPh2{width:100%;aspect-ratio:3/4;display:flex;align-items:center;justify-content:center;background:linear-gradient(135deg,#fe2c55,#f0385e);color:#fff;font-size:18px;}
  .dyThumbMk{position:absolute;right:2px;bottom:2px;background:rgba(0,0,0,.55);color:#fff;border:none;border-radius:5px;font-size:11px;padding:3px 7px;cursor:pointer;}
  /* ---- 三级钻取：分类 → 账号 → 视频 ---- */
  .dyBack{display:flex;align-items:center;gap:6px;padding:13px 16px;font-size:16px;font-weight:600;color:#9aa0b5;cursor:pointer;background:#1f2233;border-bottom:1px solid #262a3b;}
  .dyBack:active{color:#fff;}
  .dyCatRow{display:flex;align-items:center;gap:12px;padding:18px 16px;cursor:pointer;border-bottom:1px solid #262a3b;}
  .dyCatRow:active{background:#22263a;}
  .dyCatName{font-size:18px;font-weight:700;}
  .dyCatSub{font-size:13px;color:#9aa0b5;margin-top:4px;}
  .dyCatCount{background:#fe2c55;color:#fff;border-radius:13px;padding:5px 15px;font-size:16px;font-weight:700;flex:0 0 auto;}
  .dyArrow{color:#9aa0b5;font-size:26px;line-height:1;flex:0 0 auto;}
  .dyAccRow{display:flex;align-items:center;gap:12px;padding:16px;cursor:pointer;border-bottom:1px solid #262a3b;}
  .dyAccRow:active{background:#22263a;}
  .dyAccInfo{flex:1;min-width:0;}
  .dyAccName{font-size:17px;font-weight:600;}
  .dyAccSub{font-size:13px;color:#9aa0b5;margin-top:4px;}
  .dyAccHdWide{display:flex;align-items:center;gap:12px;padding:16px;background:#1f2233;border-bottom:1px solid #262a3b;}
  .dyAccHdWide .dyAvatar{width:44px;height:44px;flex:0 0 44px;font-size:18px;}
  .dyAccHdWide .dyAccInfo{flex:1;min-width:0;}
  .dyAccHdWide .dyMini{font-size:15px;padding:11px 16px;}
  /* ---- 登录失败备注框 + 一键复制 ---- */
  .dyScanStatus{display:flex;align-items:flex-start;gap:10px;padding:12px 16px;font-size:14px;color:#ffd166;background:#2a2d40;border-bottom:1px solid #262a3b;line-height:1.6;}
  .dySStext{flex:1;min-width:0;word-break:break-word;white-space:pre-wrap;}
  .dySScopy{flex:0 0 auto;border:none;border-radius:8px;padding:9px 16px;font-size:14px;font-weight:700;background:#fe2c55;color:#fff;cursor:pointer;}
  .dySScopy:active{opacity:.8;}
  `;

  function buildUI() {
    const style = document.createElement('style');
    style.textContent = CSS;
    document.head.appendChild(style);

    fab = document.createElement('div');
    fab.id = 'dyFab';
    fab.innerHTML = '▶<span id="dyBadge" style="display:none"></span>';
    fab.addEventListener('click', togglePanel);
    document.body.appendChild(fab);
    badgeEl = fab.querySelector('#dyBadge');

    panel = document.createElement('div');
    panel.id = 'dyPanel';
    panel.innerHTML =
      '<div class="dyHd"><b>抖音关注 · 未读</b><button class="dySize" id="dySize" title="缩小/放大界面">缩小</button><button class="dyClose" id="dyClose">×</button></div>' +
      '<div class="dyFt">' +
      '<button class="dyBtn primary" id="dyLogin">登录检测</button>' +
      '<button class="dyBtn" id="dyScanAll">扫描全部关注</button>' +
      '<button class="dyBtn" id="dySync">同步已读</button>' +
      '<button class="dyBtn ghost" id="dyReadAll">全部已读</button>' +
      '<button class="dyBtn ghost" id="dyClear">清除已读</button>' +
      '</div>' +
      '<div class="dyStatus"><span><span class="dot" id="dyDot"></span><span id="dyStatusText">未记录</span></span>' +
      '<span id="dyCount"></span></div>' +
      '<div class="dySummary" id="dySummary"></div>' +
      '<div class="dyScanStatus" id="dyScanStatus" style="display:none">' +
      '<div class="dySStext" id="dySStext"></div>' +
      '<button class="dySScopy" id="dySScopy">复制</button>' +
      '</div>' +
      '<div class="dyList" id="dyList"></div>';
    document.body.appendChild(panel);
    listEl = panel.querySelector('#dyList');
    statusEl = panel.querySelector('#dyStatusText');

    panel.querySelector('#dyClose').addEventListener('click', togglePanel);
    panel.querySelector('#dySize').addEventListener('click', toggleSize);
    panel.querySelector('#dyLogin').addEventListener('click', function () {
      const s = panel.querySelector('#dyScanStatus'); if (s) s.style.display = 'block';
      checkLogin();
    });
    panel.querySelector('#dyScanAll').addEventListener('click', function () {
      const s = panel.querySelector('#dyScanStatus'); if (s) s.style.display = 'block';
      runFullScanMobile();
    });
    panel.querySelector('#dyReadAll').addEventListener('click', function () { markAllRead(); });
    panel.querySelector('#dyClear').addEventListener('click', function () { clearRead(); });
    panel.querySelector('#dySync').addEventListener('click', function () {
      const s = panel.querySelector('#dyScanStatus'); if (s) s.style.display = 'block';
      getWatchHistory();
    });
    panel.querySelector('#dySScopy').addEventListener('click', function () {
      const tx = panel.querySelector('#dySStext');
      if (tx) copyText(tx.textContent);
    });

    updateBadge();
    updateRecUI();
    updateLoginUI();
    // 若不在 www.douyin.com：网页接口只存在于 www，跨域请求会被浏览器拦截，给出一次性提示
    if (location.hostname !== 'www.douyin.com' && location.hostname !== 'douyin.com') {
      setScanText('⚠️ 当前在 ' + location.hostname + '：网页接口只在 www.douyin.com 提供，跨域请求会被浏览器拦截。请在 Via 开启「桌面模式」后访问 www.douyin.com（本插件已尝试自动跳转，但被弹回）。');
    }
  }

  // 登录状态指示：反映「登录检测」是否成功过；同时兼顾被动记录状态
  function updateLoginUI() {
    const onWww = (location.hostname === 'www.douyin.com' || location.hostname === 'douyin.com');
    const logined = localStorage.getItem('DYUNREAD_LOGINED') === '1';
    const recording = isManualRecording() || isFollowUrl();
    const txt = panel && panel.querySelector('#dyStatusText');
    const btn = panel && panel.querySelector('#dyLogin');
    if (txt) txt.textContent = recording ? '记录中（自动捕获当前页视频）'
      : (onWww ? (logined ? '已登录（可扫描）' : '未登录检测') : '需在 www.douyin.com');
    if (btn) btn.textContent = logined ? '重新检测' : '登录检测';
  }

  function togglePanel() {
    panelOpen = !panelOpen;
    panel.classList.toggle('open', panelOpen);
    if (fab) fab.style.display = panelOpen ? 'none' : 'block';
    if (panelOpen) render();
  }
  // 界面大小切换：全屏大模式 ↔ 浮动小卡片模式
  let panelSmall = false;
  function toggleSize() {
    panelSmall = !panelSmall;
    panel.classList.toggle('small', panelSmall);
    const sb = panel.querySelector('#dySize');
    if (sb) sb.textContent = panelSmall ? '放大' : '缩小';
  }
  function updateRecUI() {
    // 仅更新「记录中」指示灯（原「开始记录」按钮已并入登录→扫描两步式，不再单独存在）
    const on = isManualRecording() || isFollowUrl();
    const dot = panel && panel.querySelector('#dyDot');
    if (dot) dot.classList.toggle('on', on);
  }
  function updateBadge() {
    const n = getUnread().length;
    if (!badgeEl) return;
    if (n > 0) { badgeEl.style.display = 'block'; badgeEl.textContent = n > 99 ? '99+' : String(n); }
    else { badgeEl.style.display = 'none'; }
  }
  function timeAgo(ts) {
    if (!ts) return '';
    const d = Math.floor(Date.now() / 1000) - Number(ts);
    if (d < 60) return '刚刚';
    if (d < 3600) return Math.floor(d / 60) + ' 分钟前';
    if (d < 86400) return Math.floor(d / 3600) + ' 小时前';
    return Math.floor(d / 86400) + ' 天前';
  }
  function buildGroups(unread) {
    const cats = {};
    for (const v of unread) {
      const key = accKey(v);
      const cat = v.cat || '未分类';
      if (!cats[cat]) cats[cat] = {};
      if (!cats[cat][key]) cats[cat][key] = { key: key, name: v.author || '未知作者', authorId: v.authorId || '', items: [], latest: 0 };
      cats[cat][key].items.push(v);
      cats[cat][key].latest = Math.max(cats[cat][key].latest, v.createTime || 0);
    }
    const result = {};
    for (const c in cats) {
      result[c] = Object.values(cats[c]).sort(function (a, b) { return (b.items.length - a.items.length) || ((b.latest || 0) - (a.latest || 0)); });
    }
    const names = Object.keys(result).sort(function (a, b) {
      if (a === '未分类') return 1; if (b === '未分类') return -1;
      return a.localeCompare(b, 'zh');
    });
    return { cats: result, names: names };
  }

  // 钻取导航状态：cats(分类) → accounts(某分类下的账号) → videos(某账号的视频)
  let nav = { level: 'cats', cat: null, key: null };
  function goCats() { nav = { level: 'cats', cat: null, key: null }; render(); }
  function goAccounts(cat) { nav = { level: 'accounts', cat: cat, key: null }; render(); }
  function goVideos(cat, key) { nav = { level: 'videos', cat: cat, key: key }; render(); }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  // 单个未读视频封面卡片（点 ✓ 标记已读；点图片跳转抖音）
  function makeVideoCard(v) {
    const a = document.createElement('a'); a.className = 'dyThumbWrap'; a.href = v.url; a.target = '_blank'; a.rel = 'noopener'; a.title = (v.desc || v.author || '');
    if (v.cover) {
      const img = document.createElement('img'); img.loading = 'lazy'; img.referrerPolicy = 'no-referrer'; img.src = v.cover; img.alt = v.author;
      img.onerror = function () { const ph = document.createElement('div'); ph.className = 'dyPh2'; ph.textContent = '▶'; img.replaceWith(ph); };
      a.appendChild(img);
    } else {
      const ph = document.createElement('div'); ph.className = 'dyPh2'; ph.textContent = '▶'; a.appendChild(ph);
    }
    const mk = document.createElement('button'); mk.className = 'dyThumbMk'; mk.textContent = '✓'; mk.title = '标记已读';
    mk.addEventListener('click', function (e) { e.stopPropagation(); e.preventDefault(); markRead(v.id); });
    a.appendChild(mk);
    return a;
  }

  // 一级视图：分类列表（每个分类显示「N 个账号 / M 条未读」）
  function renderCatsView(g) {
    for (const cat of g.names) {
      const accounts = g.cats[cat];
      let cAcc = 0, cUnread = 0;
      accounts.forEach(function (a) { cAcc++; cUnread += a.items.length; });
      const row = document.createElement('div'); row.className = 'dyCatRow';
      const left = document.createElement('div'); left.style.flex = '1'; left.style.minWidth = '0';
      left.innerHTML = '<div class="dyCatName">' + esc(cat) + '</div><div class="dyCatSub">' + cAcc + ' 个账号</div>';
      const cnt = document.createElement('div'); cnt.className = 'dyCatCount'; cnt.textContent = cUnread + ' 条';
      const arrow = document.createElement('div'); arrow.className = 'dyArrow'; arrow.textContent = '›';
      row.appendChild(left); row.appendChild(cnt); row.appendChild(arrow);
      row.addEventListener('click', (function (c) { return function () { goAccounts(c); }; })(cat));
      listEl.appendChild(row);
    }
  }

  // 二级视图：某分类下的公众号列表（每个账号显示未读数）
  function renderAccountsView(g) {
    const back = document.createElement('div'); back.className = 'dyBack'; back.textContent = '‹ 返回分类';
    back.addEventListener('click', goCats);
    listEl.appendChild(back);
    const accounts = g.cats[nav.cat] || [];
    for (const acc of accounts) {
      const row = document.createElement('div'); row.className = 'dyAccRow';
      const av = document.createElement('div'); av.className = 'dyAvatar'; av.textContent = (acc.name || '?').slice(0, 1);
      const info = document.createElement('div'); info.className = 'dyAccInfo';
      info.innerHTML = '<div class="dyAccName">' + esc(acc.name) + '</div><div class="dyAccSub">' + acc.items.length + ' 条未读</div>';
      const cnt = document.createElement('div'); cnt.className = 'dyAccCount'; cnt.textContent = acc.items.length;
      const arrow = document.createElement('div'); arrow.className = 'dyArrow'; arrow.textContent = '›';
      row.appendChild(av); row.appendChild(info); row.appendChild(cnt); row.appendChild(arrow);
      row.addEventListener('click', (function (k) { return function () { goVideos(nav.cat, k); }; })(acc.key));
      listEl.appendChild(row);
    }
    if (!accounts.length) {
      const e = document.createElement('div'); e.className = 'dyEmpty'; e.textContent = '该分类下暂无未读账号。';
      listEl.appendChild(e);
    }
  }

  // 三级视图：某账号的未读视频
  function renderVideosView(g) {
    const back = document.createElement('div'); back.className = 'dyBack'; back.textContent = '‹ 返回账号';
    back.addEventListener('click', function () { goAccounts(nav.cat); });
    listEl.appendChild(back);
    const accounts = g.cats[nav.cat] || [];
    let acc = null;
    for (const a of accounts) { if (a.key === nav.key) { acc = a; break; } }
    if (!acc) {
      const e = document.createElement('div'); e.className = 'dyEmpty'; e.textContent = '未找到该账号的未读视频。';
      listEl.appendChild(e); return;
    }
    const hd = document.createElement('div'); hd.className = 'dyAccHdWide';
    hd.innerHTML = '<div class="dyAvatar">' + esc((acc.name || '?').slice(0, 1)) + '</div>' +
      '<div class="dyAccInfo"><div class="dyAccName">' + esc(acc.name) + '</div><div class="dyAccSub">' + acc.items.length + ' 条未读</div></div>';
    const bAll = document.createElement('button'); bAll.className = 'dyMini'; bAll.textContent = '全部已读';
    bAll.addEventListener('click', function () { markAccountRead(acc.key); goAccounts(nav.cat); });
    hd.appendChild(bAll);
    listEl.appendChild(hd);
    const grid = document.createElement('div'); grid.className = 'dyThumbs';
    acc.items.forEach(function (v) { grid.appendChild(makeVideoCard(v)); });
    listEl.appendChild(grid);
  }

  function render() {
    if (!listEl) return;
    updateRecUI();
    updateLoginUI();
    const unread = getUnread();
    panel.querySelector('#dyCount').textContent = '未读 ' + unread.length;
    const accCount = new Set(unread.map(accKey)).size;
    const watched = loadWatched().size;
    const sumEl = panel.querySelector('#dySummary');
    if (sumEl) sumEl.textContent = unread.length
      ? (accCount + ' 个账号有未读 · 共 ' + unread.length + ' 条（已看历史 ' + watched + ' 条）')
      : '没有未读视频（已看历史 ' + watched + ' 条）';
    listEl.innerHTML = '';
    if (!unread.length) {
      const e = document.createElement('div');
      e.className = 'dyEmpty';
      e.innerHTML = '暂无未读视频。<br/>已自动扫描你关注的账号并对比观看历史——若刚扫描完仍为空，说明近期都看过了。可手动点「同步已读」刷新已看状态。';
      listEl.appendChild(e);
      return;
    }
    const g = buildGroups(unread);
    if (nav.level === 'accounts') renderAccountsView(g);
    else if (nav.level === 'videos') renderVideosView(g);
    else renderCatsView(g);
  }

  /* ---------------- 启动 ---------------- */
  function start() {
    ensureWww(); // 若当前不是 www.douyin.com，自动跳转一次到 www（规避跨域被拦）
    installFetchHook();
    installXHRHook();
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', function () {
        buildUI();
        maybeAutoRun();
        if (isFollowUrl()) scanDOM();
      });
    } else {
      buildUI();
      maybeAutoRun();
      if (isFollowUrl()) scanDOM();
    }
    // 周期性 DOM 兜底扫描 + 同步记录状态
    setInterval(function () {
      if (isFollowUrl()) scanDOM();
      if (panelOpen) updateRecUI();
    }, 5000);
    // 路由变化时同步 UI
    let lastHref = location.href;
    setInterval(function () {
      if (location.href !== lastHref) { lastHref = location.href; if (panelOpen) updateRecUI(); }
    }, 1000);
  }

  start();
})();
