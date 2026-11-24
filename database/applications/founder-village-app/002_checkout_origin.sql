ALTER TABLE app.member_checkouts ADD COLUMN return_origin text
  CHECK (return_origin IS NULL OR (method='card' AND char_length(return_origin) <= 255));
