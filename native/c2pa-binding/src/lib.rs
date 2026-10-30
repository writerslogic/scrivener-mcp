use std::io::Cursor;

use async_trait::async_trait;
use c2pa::{
    AsyncSigner, Builder, BuilderIntent, Context, Ingredient, Reader, Relationship, SigningAlg,
};
use js_sys::{Function, Object, Promise, Reflect, Uint8Array};
use serde_json::{json, Value};
use wasm_bindgen::prelude::*;
use wasm_bindgen_futures::JsFuture;

struct ClaimSigner {
    callback: Function,
    algorithm: SigningAlg,
    certificates: Vec<Vec<u8>>,
    reserve: usize,
}

#[async_trait(?Send)]
impl AsyncSigner for ClaimSigner {
    async fn sign(&self, data: Vec<u8>) -> c2pa::Result<Vec<u8>> {
        if data.is_empty() || data.len() > 8 * 1024 * 1024 {
            return Err(c2pa::Error::BadParam("Signing input limit".into()));
        }
        let value = self
            .callback
            .call1(&JsValue::UNDEFINED, &Uint8Array::from(data.as_slice()))
            .map_err(|_| c2pa::Error::BadParam("Signing callback failed".into()))?;
        let promise = value
            .dyn_into::<Promise>()
            .map_err(|_| c2pa::Error::BadParam("Signing callback must return a promise".into()))?;
        let signature = JsFuture::from(promise)
            .await
            .map_err(|_| c2pa::Error::BadParam("Signing callback failed".into()))?
            .dyn_into::<Uint8Array>()
            .map_err(|_| c2pa::Error::BadParam("Signing callback must return bytes".into()))?;
        if signature.length() == 0 || signature.length() > 1024 {
            return Err(c2pa::Error::BadParam("Signature size limit".into()));
        }
        Ok(signature.to_vec())
    }

    fn alg(&self) -> SigningAlg {
        self.algorithm
    }
    fn certs(&self) -> c2pa::Result<Vec<Vec<u8>>> {
        Ok(self.certificates.clone())
    }
    fn reserve_size(&self) -> usize {
        self.reserve
    }
    fn direct_cose_handling(&self) -> bool {
        false
    }
}

fn failure(error: c2pa::Error) -> JsValue {
    let code = match error {
        c2pa::Error::UnsupportedType => "FORMAT_UNSUPPORTED",
        _ if error
            .to_string()
            .contains("compression method not supported: 8") =>
        {
            "ZIP_COMPRESSION_UNSUPPORTED"
        }
        _ => "VALIDATION_FAILED",
    };
    JsValue::from_str(code)
}

#[wasm_bindgen]
pub async fn inspect_asset(
    mime_type: String,
    asset: Vec<u8>,
    manifest: Option<Vec<u8>>,
    settings: String,
    include_crjson: bool,
) -> Result<String, JsValue> {
    if mime_type.is_empty()
        || mime_type.len() > 127
        || asset.is_empty()
        || asset.len() > 128 * 1024 * 1024
        || manifest
            .as_ref()
            .is_some_and(|bytes| bytes.is_empty() || bytes.len() > 8 * 1024 * 1024)
        || settings.len() > 8 * 1024 * 1024
    {
        return Err(JsValue::from_str("INPUT_LIMIT"));
    }
    let context = Context::new()
        .with_settings(settings.as_str())
        .map_err(|_| JsValue::from_str("CONFIGURATION_INVALID"))?;
    let reader = Reader::from_context(context);
    let result = match manifest {
        Some(data) => {
            reader
                .with_manifest_data_and_stream_async(&data, &mime_type, Cursor::new(asset))
                .await
        }
        None => {
            reader
                .with_stream_async(&mime_type, Cursor::new(asset))
                .await
        }
    };
    let reader = match result {
        Ok(reader) => reader,
        Err(c2pa::Error::JumbfNotFound) => {
            let crjson = if include_crjson {
                Some(Reader::default().to_crjson_value().map_err(failure)?)
            } else {
                None
            };
            return Ok(json!({"report": null, "crjson": crjson}).to_string());
        }
        Err(error) => return Err(failure(error)),
    };
    let report: Value =
        serde_json::from_str(&reader.json()).map_err(|_| JsValue::from_str("REPORT_INVALID"))?;
    let crjson = if include_crjson {
        Some(reader.to_crjson_value().map_err(failure)?)
    } else {
        None
    };
    let result = json!({"report": report, "crjson": crjson}).to_string();
    if result.len() > 16 * 1024 * 1024 {
        return Err(JsValue::from_str("REPORT_LIMIT"));
    }
    Ok(result)
}

#[wasm_bindgen]
pub fn validation_time_ms(value: String) -> Result<f64, JsValue> {
    if value.len() > 64 {
        return Err(JsValue::from_str("VALIDATION_TIME_INVALID"));
    }
    chrono::DateTime::parse_from_rfc3339(&value)
        .map(|time| time.timestamp_millis() as f64)
        .map_err(|_| JsValue::from_str("VALIDATION_TIME_INVALID"))
}

#[wasm_bindgen]
pub fn core_version() -> String {
    c2pa::VERSION.to_string()
}

#[wasm_bindgen]
pub async fn sign_asset(
    mime_type: String,
    asset: Vec<u8>,
    source_manifest: Option<Vec<u8>>,
    definition: String,
    settings: String,
    certificates: String,
    algorithm: String,
    no_embed: bool,
    callback: Function,
) -> Result<JsValue, JsValue> {
    if mime_type.is_empty()
        || mime_type.len() > 127
        || asset.is_empty()
        || asset.len() > 128 * 1024 * 1024
        || definition.len() > 128 * 1024
        || settings.len() > 8 * 1024 * 1024
        || certificates.len() > 128 * 1024
        || source_manifest
            .as_ref()
            .is_some_and(|bytes| bytes.is_empty() || bytes.len() > 8 * 1024 * 1024)
    {
        return Err(JsValue::from_str("INPUT_LIMIT"));
    }
    let certificates: Vec<Vec<u8>> = pem::parse_many(certificates)
        .map_err(|_| JsValue::from_str("SIGNER_CERTIFICATE_INVALID"))?
        .into_iter()
        .map(|entry| entry.into_contents())
        .collect();
    if certificates.is_empty() || certificates.len() > 32 {
        return Err(JsValue::from_str("SIGNER_CERTIFICATE_INVALID"));
    }
    let algorithm = algorithm
        .parse::<SigningAlg>()
        .map_err(|_| JsValue::from_str("SIGNER_ALGORITHM_UNSUPPORTED"))?;
    let reserve = certificates.iter().map(Vec::len).sum::<usize>() + 32 * 1024;
    let signer = ClaimSigner {
        callback,
        algorithm,
        certificates,
        reserve,
    };
    let context = Context::new()
        .with_settings(settings.as_str())
        .map_err(|_| JsValue::from_str("CONFIGURATION_INVALID"))?;
    let mut builder = Builder::from_context(context)
        .with_definition(definition.as_str())
        .map_err(failure)?;
    builder.set_intent(BuilderIntent::Edit);
    builder.set_no_embed(no_embed);
    if let Some(manifest) = source_manifest {
        let context = Context::new()
            .with_settings(settings.as_str())
            .map_err(|_| JsValue::from_str("CONFIGURATION_INVALID"))?;
        let reader = Reader::from_context(context)
            .with_manifest_data_and_stream_async(&manifest, &mime_type, Cursor::new(&asset))
            .await
            .map_err(failure)?;
        let active = reader
            .active_manifest()
            .ok_or(JsValue::from_str("SOURCE_CREDENTIALS_INVALID"))?;
        // The SDK's reader shortcut imports an archive's parent rather than the current asset.
        let mut ingredient = Ingredient::from_json(
            &json!({
                "title": active.title().unwrap_or("Source asset"),
                "format": mime_type,
                "instance_id": active.instance_id(),
                "active_manifest": reader.active_label(),
                "validation_results": reader.validation_results(),
            })
            .to_string(),
        )
        .map_err(failure)?;
        ingredient.set_manifest_data(manifest).map_err(failure)?;
        ingredient.set_relationship(Relationship::ParentOf);
        builder.add_ingredient(ingredient);
    }
    let mut input = Cursor::new(asset);
    let mut output = Cursor::new(Vec::new());
    let manifest = builder
        .sign_async(&signer, &mime_type, &mut input, &mut output)
        .await
        .map_err(failure)?;
    let signed_asset = output.into_inner();
    if manifest.len() > 8 * 1024 * 1024 || signed_asset.len() > 136 * 1024 * 1024 {
        return Err(JsValue::from_str("OUTPUT_LIMIT"));
    }
    let result = Object::new();
    Reflect::set(
        &result,
        &JsValue::from_str("manifest"),
        &Uint8Array::from(manifest.as_slice()),
    )?;
    Reflect::set(
        &result,
        &JsValue::from_str("asset"),
        &Uint8Array::from(signed_asset.as_slice()),
    )?;
    Ok(result.into())
}
