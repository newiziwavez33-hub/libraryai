<?php
header('Content-Type: application/json; charset=utf-8');
require_once __DIR__ . '/../config.php';

$isbn = isset($_GET['isbn']) ? $_GET['isbn'] : '';
if (!$isbn) { http_response_code(400); echo json_encode(['error' => 'no_isbn']); exit; }

// Check DB for existing annotation
$stmt = $conn->prepare('SELECT isbn, title, authors, cover_url, annotation, created_at FROM annotations WHERE isbn = ? LIMIT 1');
$stmt->bind_param('s', $isbn);
$stmt->execute();
$res = $stmt->get_result();
if ($row = $res->fetch_assoc()) {
    echo json_encode(['ok' => true, 'data' => $row]);
    exit;
}

// Not found: generate via Qwen (or other LLM) - requires API key set in server environment or in code.
// The project owner indicated a key exists in client script; here we use placeholder env var QWEN_API_KEY.
$title = isset($_GET['title']) ? $_GET['title'] : '';
$authors = isset($_GET['authors']) ? $_GET['authors'] : '';
$cover = isset($_GET['cover_url']) ? $_GET['cover_url'] : '';

$prompt = "Сгенерируй краткую аннотацию книги: {$title} ({$authors})\nДай 3-4 предложения, понятным языком.";

$qwen_key = getenv('QWEN_API_KEY') ?: 'YOUR_QWEN_API_KEY';
$ch = curl_init('https://dashscope.aliyuncs.com/api/v1/services/aigc/text-generation/generation');
curl_setopt_array($ch, [
    CURLOPT_RETURNTRANSFER => true,
    CURLOPT_HTTPHEADER => [
        'Authorization: Bearer ' . $qwen_key,
        'Content-Type: application/json'
    ],
    CURLOPT_POST => true,
    CURLOPT_POSTFIELDS => json_encode([
        'model' => 'qwen-plus',
        'input' => ['prompt' => $prompt]
    ])
]);
$response = curl_exec($ch);
$http_code = curl_getinfo($ch, CURLINFO_HTTP_CODE);
curl_close($ch);

if (!$response || $http_code !== 200) {
    http_response_code(502);
    echo json_encode(['ok' => false, 'error' => 'generation_failed']);
    exit;
}

$data = json_decode($response, true);
$annotation = '';
if (isset($data['output']) && is_array($data['output'])) {
    if (isset($data['output'][0]['content'])) {
        $annotation = is_string($data['output'][0]['content']) ? $data['output'][0]['content'] : json_encode($data['output'][0]['content']);
    } else if (isset($data['output'][0]['text'])) {
        $annotation = $data['output'][0]['text'];
    } else if (isset($data['output']['text'])) {
        $annotation = $data['output']['text'];
    }
}
if (!$annotation && isset($data['choices'][0]['message']['content'])) {
    $annotation = $data['choices'][0]['message']['content'];
}
if (!$annotation) $annotation = 'Не удалось получить аннотацию.';

// Save to DB
$stmt = $conn->prepare('INSERT INTO annotations (isbn, title, authors, cover_url, annotation) VALUES (?, ?, ?, ?, ?)');
$stmt->bind_param('sssss', $isbn, $title, $authors, $cover, $annotation);
$stmt->execute();

echo json_encode(['ok' => true, 'data' => ['isbn' => $isbn, 'title' => $title, 'authors' => $authors, 'cover_url' => $cover, 'annotation' => $annotation]]);
?>
