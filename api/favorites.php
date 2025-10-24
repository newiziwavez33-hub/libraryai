<?php
header('Content-Type: application/json; charset=utf-8');
require_once __DIR__ . '/../config.php';

// Verify Google ID token (id_token) sent in Authorization: Bearer <id_token>
function verifyGoogleToken($token) {
    if (!$token) return null;
    $resp = @file_get_contents("https://oauth2.googleapis.com/tokeninfo?id_token=" . urlencode($token));
    if (!$resp) return null;
    $data = json_decode($resp, true);
    if (empty($data['sub'])) return null;
    return $data;
}

$headers = getallheaders();
$auth = isset($headers['Authorization']) ? $headers['Authorization'] : (isset($headers['authorization']) ? $headers['authorization'] : '');
$token = trim(str_replace('Bearer', '', $auth));
$user = verifyGoogleToken($token);

$method = $_SERVER['REQUEST_METHOD'];

// If not authorized, return 401 for favorites
if (!$user) {
    http_response_code(401);
    echo json_encode(['error' => 'unauthorized']);
    exit;
}

$user_id = $conn->real_escape_string($user['sub']);

if ($method === 'GET') {
    $stmt = $conn->prepare('SELECT isbn, title, authors, cover_url, created_at FROM favorites WHERE user_id = ? ORDER BY created_at DESC');
    $stmt->bind_param('s', $user_id);
    $stmt->execute();
    $res = $stmt->get_result();
    $rows = $res->fetch_all(MYSQLI_ASSOC);
    echo json_encode(['ok' => true, 'data' => $rows]);
    exit;
}

if ($method === 'POST') {
    $data = json_decode(file_get_contents('php://input'), true);
    $isbn = isset($data['isbn']) ? $data['isbn'] : '';
    $title = isset($data['title']) ? $data['title'] : '';
    $authors = isset($data['authors']) ? $data['authors'] : '';
    $cover = isset($data['cover_url']) ? $data['cover_url'] : '';

    $stmt = $conn->prepare('INSERT INTO favorites (user_id, isbn, title, authors, cover_url) VALUES (?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE title = VALUES(title), authors = VALUES(authors), cover_url = VALUES(cover_url)');
    $stmt->bind_param('sssss', $user_id, $isbn, $title, $authors, $cover);
    $ok = $stmt->execute();
    if (!$ok) {
        http_response_code(500);
        echo json_encode(['ok' => false, 'error' => 'db_error']);
        exit;
    }
    echo json_encode(['ok' => true]);
    exit;
}

if ($method === 'DELETE') {
    // expecting URL like /api/favorites.php?isbn=XXXX or /api/favorites.php/<isbn>
    $isbn = isset($_GET['isbn']) ? $_GET['isbn'] : '';
    if (!$isbn) {
        // try parsing from REQUEST_URI
        $parts = explode('/', $_SERVER['REQUEST_URI']);
        $last = end($parts);
        $isbn = $last ? $last : '';
    }
    $stmt = $conn->prepare('DELETE FROM favorites WHERE user_id = ? AND isbn = ?');
    $stmt->bind_param('ss', $user_id, $isbn);
    $stmt->execute();
    echo json_encode(['ok' => true]);
    exit;
}

http_response_code(405);
echo json_encode(['error' => 'method_not_allowed']);
?>
