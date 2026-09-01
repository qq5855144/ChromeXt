package org.matrix.chromext.script

import android.content.Context
import android.database.sqlite.SQLiteDatabase
import android.database.sqlite.SQLiteOpenHelper
import org.json.JSONObject

data class Script(
    val id: String,
    val match: Array<String>,
    val grant: Array<String>,
    val exclude: Array<String>,
    var meta: String,
    val code: String,
    var storage: JSONObject?,
    val lib: List<String> = mutableListOf<String>(),
    val noframes: Boolean,
    val runAt: String = "document-idle",
    val injectInto: String = "page",
    val sandbox: String = "raw",
    var enabled: Boolean = true,
)

private const val SQL_CREATE_ENTRIES =
    "CREATE TABLE script (id TEXT PRIMARY KEY NOT NULL, meta TEXT NOT NULL, code TEXT NOT NULL, storage TEXT, enabled INTEGER NOT NULL DEFAULT 1);"

class ScriptDbHelper(context: Context) :
    SQLiteOpenHelper(context, DATABASE_NAME, null, DATABASE_VERSION) {

  override fun onCreate(db: SQLiteDatabase) {
    db.execSQL(SQL_CREATE_ENTRIES)
  }

  override fun onUpgrade(db: SQLiteDatabase, oldVersion: Int, newVersion: Int) {
    if (oldVersion < 7) {
      db.execSQL("DROP TABLE script;")
      onCreate(db)
      return
    }

    if (oldVersion == 7 && newVersion == 8) {
      db.execSQL("CREATE TABLE tmp AS SELECT id,meta,code,storage FROM script;")
      db.execSQL("DROP TABLE script;")
      db.execSQL("ALTER TABLE tmp RENAME TO script;")
    }

    if (oldVersion == 8 && newVersion == 9) {
      db.execSQL("CREATE TABLE tmp AS SELECT id,meta,code,storage FROM script;")
      db.execSQL("DROP TABLE script;")
      db.execSQL(
          "CREATE TABLE script (id TEXT PRIMARY KEY NOT NULL, meta TEXT NOT NULL, code TEXT NOT NULL, storage TEXT);")
      db.execSQL(
          "INSERT INTO script (id,meta,code) SELECT id,meta,code FROM tmp WHERE storage = '';")
      db.execSQL("INSERT INTO script SELECT * FROM tmp WHERE storage != '';")
      db.execSQL("DROP TABLE tmp;")
    }

    if (oldVersion == 9 && newVersion == 10) {
      db.execSQL("ALTER TABLE script ADD COLUMN enabled INTEGER NOT NULL DEFAULT 1;")
    }

    if (newVersion - oldVersion > 1) {
      onUpgrade(db, oldVersion, oldVersion + 1)
      onUpgrade(db, oldVersion + 1, newVersion)
    }
  }

  override fun onDowngrade(db: SQLiteDatabase, oldVersion: Int, newVersion: Int) {}

  companion object {
    const val DATABASE_VERSION = 10
    const val DATABASE_NAME = "userscript"
  }
}
