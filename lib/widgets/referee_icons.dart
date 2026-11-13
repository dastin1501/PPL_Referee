import 'package:flutter/material.dart';
import 'package:flutter_svg/flutter_svg.dart';
import '../theme/ppl_colors.dart';

/// Inline SVG symbols from `lib/screens/referee-icons.html`
/// (`#icon-band`, `#icon-ball`).

String _bandSvg() {
  // Colors baked in — flutter_svg does not resolve CSS variables.
  const dark = '#1E7E6A';
  const mid = '#3BB89B';
  const light = '#6AD6BC';
  return '''
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200">
  <g transform="translate(100 100) rotate(-35) scale(.92) translate(-100 -66)">
    <ellipse cx="100" cy="50" rx="90" ry="30" fill="$dark"/>
    <path d="M10 50 A90 30 0 0 0 190 50 L190 82 A90 30 0 0 1 10 82 Z" fill="$mid"/>
    <ellipse cx="100" cy="50" rx="90" ry="30" fill="none" stroke="$light" stroke-width="3"/>
    <path d="M52 94 h16 M47 100 h16" stroke="#fff" stroke-opacity=".85" stroke-width="3" stroke-linecap="round"/>
    <text x="108" y="102" text-anchor="middle" font-size="24" font-weight="800" font-style="italic"
          font-family="system-ui,Arial,sans-serif" fill="#fff" fill-opacity=".92" letter-spacing="2">PPL</text>
  </g>
</svg>
''';
}

String _ballSvg() {
  return '''
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
  <circle cx="50" cy="50" r="46" fill="#a4d62a"/>
  <circle cx="50" cy="50" r="46" fill="none" stroke="#8fbf1f" stroke-width="2"/>
  <path d="M20 28 A40 40 0 0 1 62 10" stroke="#fff" stroke-opacity=".35" stroke-width="4" fill="none" stroke-linecap="round"/>
  <g fill="#fff">
    <ellipse cx="50" cy="32" rx="8" ry="8.5"/>
    <ellipse cx="72" cy="48" rx="9" ry="9"/>
    <ellipse cx="32" cy="50" rx="9" ry="9"/>
    <ellipse cx="50" cy="68" rx="8" ry="8.5"/>
    <ellipse cx="30" cy="22" rx="5" ry="6" transform="rotate(-30 30 22)"/>
    <ellipse cx="76" cy="26" rx="5" ry="6" transform="rotate(35 76 26)"/>
    <ellipse cx="18" cy="68" rx="5" ry="6" transform="rotate(-40 18 68)"/>
    <ellipse cx="82" cy="70" rx="5" ry="6" transform="rotate(40 82 70)"/>
    <ellipse cx="48" cy="86" rx="6" ry="4"/>
  </g>
</svg>
''';
}

/// Teal PPL wristband — base player/team marker (`#icon-band`).
class RefereeBandIcon extends StatelessWidget {
  const RefereeBandIcon({super.key, this.size = 28});

  final double size;

  @override
  Widget build(BuildContext context) {
    return SvgPicture.string(
      _bandSvg(),
      width: size,
      height: size,
      fit: BoxFit.contain,
    );
  }
}

/// Lime pickleball — server marker (`#icon-ball`). Color is fixed.
class RefereeBallIcon extends StatelessWidget {
  const RefereeBallIcon({super.key, this.size = 28});

  final double size;

  @override
  Widget build(BuildContext context) {
    return SvgPicture.string(
      _ballSvg(),
      width: size,
      height: size,
      fit: BoxFit.contain,
      colorFilter: null,
    );
  }
}

/// Mirrors `renderServer(el, serveNumber)` from referee-icons.html:
/// serveNumber 1 → one ball, 2 → two balls. Side-out to first server → 1.
class RefereeServerBalls extends StatelessWidget {
  const RefereeServerBalls({
    super.key,
    required this.serveNumber,
    this.size = 22,
  });

  /// 1 = first serve, 2 = second serve (doubles).
  final int serveNumber;
  final double size;

  @override
  Widget build(BuildContext context) {
    final count = serveNumber == 2 ? 2 : 1;
    return Row(
      mainAxisSize: MainAxisSize.min,
      children: [
        for (var i = 0; i < count; i++) ...[
          if (i > 0) const SizedBox(width: 2),
          RefereeBallIcon(size: size),
        ],
      ],
    );
  }
}

/// Theme extension so widgets can read PPL teal from [ThemeData].
@immutable
class PplTheme extends ThemeExtension<PplTheme> {
  const PplTheme({
    this.teal = PplColors.teal,
    this.tealLight = PplColors.tealLight,
    this.tealDark = PplColors.tealDark,
    this.slate = PplColors.slate,
  });

  final Color teal;
  final Color tealLight;
  final Color tealDark;
  final Color slate;

  @override
  PplTheme copyWith({
    Color? teal,
    Color? tealLight,
    Color? tealDark,
    Color? slate,
  }) {
    return PplTheme(
      teal: teal ?? this.teal,
      tealLight: tealLight ?? this.tealLight,
      tealDark: tealDark ?? this.tealDark,
      slate: slate ?? this.slate,
    );
  }

  @override
  PplTheme lerp(ThemeExtension<PplTheme>? other, double t) {
    if (other is! PplTheme) return this;
    return PplTheme(
      teal: Color.lerp(teal, other.teal, t) ?? teal,
      tealLight: Color.lerp(tealLight, other.tealLight, t) ?? tealLight,
      tealDark: Color.lerp(tealDark, other.tealDark, t) ?? tealDark,
      slate: Color.lerp(slate, other.slate, t) ?? slate,
    );
  }
}
