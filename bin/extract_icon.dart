import 'dart:convert';
import 'dart:io';

void main() async {
  final svgPath = 'assets/images/vite.svg';
  final outPath = 'assets/images/app_icon.png';
  final svgFile = File(svgPath);
  if (!await svgFile.exists()) {
    stderr.writeln('SVG not found at $svgPath');
    exit(1);
  }
  final svg = await svgFile.readAsString();
  final match = RegExp(r'data:image/png;base64,([A-Za-z0-9+/=]+)').firstMatch(svg);
  if (match == null) {
    stderr.writeln('No embedded PNG found in $svgPath');
    exit(2);
  }
  final b64 = match.group(1)!;
  final bytes = base64.decode(b64);
  final outFile = File(outPath);
  await outFile.writeAsBytes(bytes);
  stdout.writeln('Wrote $outPath (${bytes.length} bytes)');
}
