<?php
// config.php - fill your MySQL credentials here
$host = "localhost";
$user = "xxolegln_1";
$pass = "Radio3333";
$dbname = "xxolegln_1";

$conn = new mysqli($host, $user, $pass, $dbname);
if ($conn->connect_error) {
    http_response_code(500);
    die(json_encode(["error" => "DB connection failed"]));
}
$conn->set_charset("utf8mb4");
?>
