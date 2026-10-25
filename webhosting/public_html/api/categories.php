<?php
/** GET  /api/categories.php → { categories, limits } */
require __DIR__ . '/_bootstrap.php';

json_out([
    'categories' => [
        'Gaming', 'Football', 'Basketball', 'MMA & Boxing', 'Motorsport', 'Pets & Animals',
        'Cooking', 'Comedy Pranks', 'Music', 'Dance', 'Travel Vlogs', 'Fitness',
        'Tech Reviews', 'Cars', 'Fashion & Beauty', 'Science Experiments', 'Magic Tricks',
        'Extreme Sports', 'Street Food', 'Stand-up Comedy', 'Nature & Wildlife', 'Esports Highlights',
    ],
    'limits' => limits(),
]);
