/*global angular, CSV*/

angular.module('webwalletApp').controller('AccountSendCtrl', function (
    temporaryStorage,
    flash,
    utils,
    config,
    deviceList,
    $filter,
    $scope,
    $rootScope,
    $routeParams,
    $q,
    $modal,
    $log,
    modalOpener,
    $http) {

    'use strict';

    var STORAGE_TXVALUES = 'trezorSendValues',
        DEFAULT_ALT_CURRENCY = 'USD',
        TIMEOUT_AMOUNT_ERR = 500,
        _supportedAltCurrenciesCache = null,
        _timeoutsAmountErr = [];

    // Scope defaults
    $scope.tx = {
        values: null,
        prepared: null,
        error: null,
        fee: null
    };
    $scope.sending = false;

    // Start by loading tx values from localStorage or Bitcoin URI (if passed).
    loadTxValues();

    /**
     * Fill the list of all supported alt currencies and recalculate alt amount
     * on each tx output.
     */
    function fillAltCurrencies() {
        getSupportedAltCurrencies().then(function (currencies) {
            $scope.currenciesAlt = currencies;
            if (!$scope.tx.values && $scope.tx.values.outputs) {
                return $q.when([]);
            }
            
            var wantedCurrencies={};
            $scope.tx.values.outputs.forEach(function(output) {
                wantedCurrencies[output.currencyAlt]=1;
            });

            var currencyPromises={}

            for (var currency in wantedCurrencies) {
                currencyPromises[currency]=getConversionRate(currency)
            }
            var outputsPromises = $scope.tx.values.outputs.map(function (output) {
                var currency=currencyPromises[output.currencyAlt];
                return convertToAltCurrencyToCopied(output,currency);
            });
            return $q.all(outputsPromises)
        }).then(function(outputs){
            $scope.tx.values.outputs=outputs;
        });
    }

    /**
     * Create a new tx output Object with the default values filled.
     *
     * This method loads the list of supported alt currencies before returning
     * the new output, because the list must be available before setting the
     * currently selected alt currency of the output.
     *
     * @return {Object}  Tx output Object
     */
    function newOutput() {
        fillAltCurrencies();
        return _doFillOutput({});
    }

    /**
     * Fill passed tx output Object with the default values, if they are not
     * filled already.
     *
     * @return output {Object}  Tx output in format:
     *                          {address: String, amount: String,
     *                          amountAlt: String, currencyAlt: String}
     * @return {Object}         Tx output Object with default values filled
     */
    function fillOutput(output) {
        fillAltCurrencies();
        return _doFillOutput(output || {});
    }

    /**
     * Fill passed tx output Objects with the default values, if they are not
     * filled already.
     *
     * @return outputs {Array}  Array of tx outputs in format:
     *                          {address: String, amount: String,
     *                          amountAlt: String, currencyAlt: String}
     * @return {Array}          Array of tx outputs Objects with default
     *                          values filled
     */
    function fillOutputs(outputs) {
        fillAltCurrencies();
        return outputs.map(function (output) {
            return _doFillOutput(output);
        });
    }

    //-------------------------------------------------
    // A few "stupid" functions for working with output objects

    /**
     * This just returns a copy of the output
     */
    function _deepCopyOutput(output) {
        return {
            address: output.address,
            amount: output.amount,
            amountAlt: output.amountAlt,
            currencyAlt: output.currencyAlt
        };
    }

    /**
     * This copies all the information from one output to another output
     */
    function _copyOutputFrom(source, target) {
        target.address = source.address;
        target.amount = source.amount;
        target.amountAlt = source.amountAlt;
        target.currencyAlt = source.currencyAlt;
    }

    /**
     * This returns outputs with some values pre-filled
     */
    function _doFillOutput(output) {
        return {
            address: output.address,
            amount: output.amount || '',
            amountAlt: output.amountAlt || '',
            currencyAlt: output.currencyAlt
        };
    }

    /**
     * If a transaction output was specified in an HTTP GET param, use that
     * value first.  Otherwise load previously filled output values from
     * localStorage.
     */
    function loadTxValues() {
        if ($routeParams.output) {
            var output = {
                address: $routeParams.output
            };
            if ($routeParams.amount) {
                output.amount = $routeParams.amount;
            }
            $scope.tx.values = {
                outputs: [fillOutput(output)]
            };
        } else {
            $scope.tx.values = {
                outputs: fillOutputs(
                    restoreTxValues().outputs
                )
            };
        }
    }

    /**
     * Save currently filled tx outputs in localStorage.
     */
    function saveTxValues() {
        temporaryStorage[STORAGE_TXVALUES] = JSON.stringify($scope.tx.values);
    }

    /**
     * Remove all tx outputs store in localStorage.
     */
    function cancelTxValues() {
        delete temporaryStorage[STORAGE_TXVALUES];
    }

    $scope.cancelTxValues = cancelTxValues;

    /**
     * Restore tx values from localStorage.
     *
     * @return {Object}  Tx values in format:
     *                   { outputs: Array of tx output objects }
     */
    function restoreTxValues() {
        if (temporaryStorage[STORAGE_TXVALUES]) {
            return JSON.parse(temporaryStorage[STORAGE_TXVALUES]);
        }
        return {
            outputs: [newOutput()]
        };
    }

    // Tx preparing

    $scope.$watch(
        function () {
            return $scope.account.balance !== null;
        },
        function (hasBalance) {
            if (hasBalance) {
                prepareTx($scope.tx.values);
            }
        }
    );

    $scope.$watch('tx.values', function (nval, oval) {
        if (nval !== oval) {
            saveTxValues();
            prepareTx(nval);
        }
    }, true);

    function prepareTx(vals) {
        var preparedOuts = [],
            outsOk = true;

        cancel(); // reset already prepared tx

        if (!vals) {
            return;
        }

        vals.outputs.forEach(prepareOutput);
        if (outsOk && preparedOuts.length) {
            $scope.account.buildTx(preparedOuts, $scope.device).then(success, cancel);
        } else {
            cancel();
        }

        function prepareOutput(out, i) {
            var address = out.address,
                amount = out.amount,
                pout;

            address = address ? address.trim() : '';
            amount = amount ? amount.trim() : '';
            if (!address || !amount) {
                return; // skip empty fields in silence
            }
            amount = utils.str2amount(amount);

            try {
                pout = $scope.account.buildTxOutput(address, amount);
            } catch (e) {
                if (e.field === $scope.account.FIELD_ADDRESS) {
                    out.error = out.error || {};
                    out.error.address = e.message;
                } else if (e.field === $scope.account.FIELD_AMOUNT) {
                    /*
                     * Wait for the user to finish typing before showing
                     * an error that the amount is too low.
                     */
                    if (_timeoutsAmountErr[i]) {
                        window.clearTimeout(_timeoutsAmountErr[i]);
                    }
                    _timeoutsAmountErr[i] = window.setTimeout(function () {
                        out.error = out.error || {};
                        out.error.amount = e.message;
                    }, TIMEOUT_AMOUNT_ERR);
                } else {
                    out.error = e.message;
                }
            }

            if (pout) {
                if (_timeoutsAmountErr[i]) {
                    window.clearTimeout(_timeoutsAmountErr[i]);
                }
                preparedOuts.push(pout);
                out.error = null;
            } else {
                outsOk = false;
            }
        }

        function success(tx) {
            $scope.tx.fee = utils.amount2str(tx.fee);
            $scope.tx.prepared = tx;
            $scope.tx.error = null;
        }

        function cancel(err) {
            $scope.tx.fee = null;
            $scope.tx.prepared = null;
            if (err) {
                $scope.tx.error = err.message || 'Failed to prepare transaction.';
            }
        }
    }

    // QR scan

    $scope.qr = {
        outputIndex: undefined,
        address: undefined,
        scanning: false,
        enabled:
        navigator.getUserMedia || navigator.webkitGetUserMedia ||
            navigator.mozGetUserMedia || navigator.msGetUserMedia
    };

    $scope.$watch('qr.address', qrAddressModified);

    function qrAddressModified(val) {
        var values, output;

        if (!$scope.qr.scanning) {
            return;
        }
        $scope.qr.scanning = false;

        if (!val) {
            $scope.qr.address = undefined;
            return;
        }

        values = parseQr(val);
        if (!values) {
            return flash.error('Provided QR code does not contain valid address');
        }

        output = $scope.tx.values.outputs[$scope.qr.outputIndex];
        if (values.address) {
            output.address = values.address;
        }
        if (values.amount) {
            output.amount = values.amount;
        }
        $scope.qr.address = undefined;
    }

    function parseQr(str) {
        var vals, query;

        if (str.indexOf('bitcoin:') === 0) {
            str = str.substring(8);
        }

        query = str.split('?');
        vals = (query.length > 1) ? parseQuery(query[1]) : {};
        vals.address = query[0];

        if (vals.address.length < 27 || vals.address.length > 34) {
            return;
        }

        return vals;
    }

    function parseQuery(str) {
        return str.split('&')
            .map(function (val) {
                return val.split('=');
            })
            .reduce(function (vals, pair) {
                if (pair.length > 1) {
                    vals[pair[0]] = pair[1];
                }
                return vals;
            }, {});
    }

    // Output/tx confirmation

    $rootScope.$on('modal.button.show', modalShown);

    function modalShown(event, code) {
        if (code === 'ButtonRequest_ConfirmOutput') {
            injectTxInfo(event.targetScope, true);
        }
        if (code === 'ButtonRequest_SignTx') {
            injectTxInfo(event.targetScope, false);
        }
    }

    function injectTxInfo(scope, injectOutput) {
        var prepared = $scope.tx.prepared;

        scope.account = $scope.account;
        scope.tx = prepared;

        if (!prepared || !injectOutput) {
            return;
        }

        // detect internal output
        if (prepared.outputs[$scope.outputIndex] &&
                prepared.outputs[$scope.outputIndex].address_n) {
            $scope.outputIndex++;
        }

        if (prepared.outputs[$scope.outputIndex]) {
            scope.output = prepared.outputs[$scope.outputIndex];
            $scope.outputIndex++;
        }
    }

    // Sending

    $scope.send = function () {
        var tx = $scope.tx.prepared,
            redirectUrl;
        if (!tx) {
            return;
        }

        $scope.sending = true;
        $scope.outputIndex = 0;

        $scope.account.sendTx(tx, $scope.device).then(
            function (res) {
                cancelTxValues();
                $scope.sending = false;

                redirectUrl = ['/device/', $scope.device.id, '/account/',
                    $scope.account.id].join('');

                utils.redirect(redirectUrl).then(function () {
                    res.hashRev = res.hash.slice();
                    res.hashRev.reverse();
                    var hashHex = utils.bytesToHex(res.hashRev);
                    flash.success({
                        template: [
                            'Transaction <a href="{{url}}" target="_blank" ',
                            'title="Transaction info at {{title}}">{{hashHex}}</a> ',
                            'was successfully sent.'
                        ].join(''),
                        hashHex: hashHex,
                        url: config.blockExplorers[config.coin].urlTx + hashHex,
                        title: config.blockExplorers[config.coin].name
                    });
                });
            },
            function (err) {
                $scope.sending = false;

                if (err.value && err.value.bytes) {
                    flash.error({
                        template: [
                            'Failed to send transaction: {{message}}.<br><br>',
                            'Raw transaction in hex format:<br>',
                            '<span class="text-monospace">{{bytes}}</span><br>',
                            'You can try to resend this transaction using',
                            '<a href="https://blockchain.info/pushtx" target="_blank">',
                            'Blockchain.info\'s Broadcast Transaction tool</a>.'
                        ].join('\n'),
                        bytes: utils.bytesToHex(err.value.bytes),
                        message: err.message,
                        show_raw_tx: false
                    });
                    return;
                }

                flash.error([
                    'Failed to send transaction: ',
                    err.message,
                    '.'
                ].join(''));
            }
        );
    };

    $scope.removeOutput = function (i) {
        $scope.tx.values.outputs.splice(i, 1);
    };

    $scope.addOutput = function () {
        $scope.tx.values.outputs.push(newOutput());
    };

    $scope.removeAllOutputs = function () {
        $scope.tx.values.outputs = [newOutput()];
    };

    // Suggest the highest possible amount to pay, taking filled
    // amounts in consideration

    $scope.suggestAmount = function () {
        var ptx = $scope.tx.prepared,
            account = $scope.account,
            outputSum = ptx ? ptx.outputSum : 0,
            available = parseInt(account.balance.toString(), 10);

        return $filter('amount')(available - outputSum);
    };

    // Address suggestion

    $scope.suggestAddresses = function () {
        var currentDevice = $scope.device,
            currentAccount = $scope.account,
            suggestedAccounts = [],
            multipleDevices = deviceList.count() > 1;
        deviceList.all().forEach(function (dev) {
            dev.accounts.forEach(function (acc) {
                if (dev.id === currentDevice.id &&
                        acc.id === currentAccount.id) {
                    return;
                }
                suggestedAccounts.push([dev, acc]);
            });
        });

        return suggestedAccounts.map(function (item) {
            var dev = item[0],
                acc = item[1],
                address = acc.address(0).address,
                label;
            if (multipleDevices) {
                label = dev.label() + ' / ' + acc.label();
            } else {
                label = acc.label();
            }

            return {
                label: label + ': ' + address,
                address: address,
                source: 'Accounts'
            };
        });
    };

    /**
     * Scan QR
     */
    $scope.scanQr = function (i) {
        promptQr()
            .then(function () {
                $scope.qr.scanning = true;
                $scope.qr.outputIndex = i;
            }, function () {
                $scope.qr.scanning = false;
            });
    };

    /**
     * Prompt QR
     */
    function promptQr() {
        return modalOpener.openModal($scope, 'qr','lg').result;
    }

    /**
     * Import CSV -- read data from passed Angular.js form, parse it, and fill
     * in tx outputs.
     *
     * @param {Object} [form]  Angular.js form values.  It should contain keys:
     *                         `data`,
     *                         `cellDelimiter`,
     *                         `header`,
     *                         `lineDelimiter`
     * @return {String|null}   Error message if import failed, otherwise null.
     */
    function importCsv(form) {
        var data,
            options,
            line,
            lines,
            len,
            i,
            colAddress,
            colAmount;

        // Sanitize CSV data
        data = form.data.replace('\r', '\n').replace('\n\n', '\n');
        if (!data) {
            return 'Please fill the CSV.';
        }

        // Sanitize CSV options
        options = {
            cellDelimiter: (form.delimiter || '')[0] || ',',
            header: !!form.header,
            lineDelimiter: '\n'
        };

        // Parse CSV
        lines = new CSV(data, options).parse();
        len = lines.length;
        if (!len) {
            return 'Unable to parse the CSV.';
        }

        // Fill outputs
        if (options.header) {
            colAddress = 'address';
            colAmount = 'amount';
        } else {
            colAddress = 0;
            colAmount = 1;
        }

        //We don't push outputs into the scope directly one by one, but in batch,
        //because otherwise we would compute and replace altcurrencies for each added
        //output extra
        //
        //addedOutputs are the  ones we will be adding
        var addedOutputs=[]


        /*
         * Can't use CSV#forEach() because of a bug in the library:
         * `data is undefined`.
         */
        for (i = 0; i < len; i = i + 1) {
            line = lines[i];
            if (!line[colAddress]) {
                return 'Address column not found in the CSV.';
            }
            if (!line[colAmount]) {
                return 'Amount column not found in the CSV.';
            }
            addedOutputs.push({
                    address: line[colAddress].toString(),
                    amount: line[colAmount].toString(),
                    currencyAlt: DEFAULT_ALT_CURRENCY
            });
        }

        addedOutputs=fillOutputs(addedOutputs);

        //newOutputs is what the new outputs will be
        var newOutputs=$scope.tx.values.outputs.concat(addedOutputs);


        // Trim empty old outputs from the beginning
        while (newOutputs.length > 1 &&
               !newOutputs[0].amount &&
               !newOutputs[0].address) {
            newOutputs.shift();
        }

        //and here it is set in batch
        $scope.tx.values.outputs = newOutputs
        return null;
    }

    /**
     * Open a CSV import modal dialog.
     */
    $scope.promptCsv = function () {

        var modal= modalOpener.openModal($scope, 'csv','lg',{
            values: {
                data: '',
                delimiter: ',',
                header: true
            },
            submit: function (form) {
                var errMsg = importCsv(form);
                if (!errMsg) {
                    modal.modal.close();
                } else {
                    scope.errMsg = errMsg;
                }
            }
        });

        $scope.$on('qr.address', function () {
            modal.modal.close();
        });

        return modal.result;
    };

    /**
     * Convert amount on passed transaction output from BTC to another
     * currency.
     *
     * Fills the `amountAlt` property on the passed tx output object.
     *
     * @param {Object} output  Output in format:
     *              {amount: String, amountAlt: String, currencyAlt: String...}
     * @return {Promise}       Fulfilled when finished
     */
    $scope.convertToBtc = function (output) {
        var amountAlt = +output.amountAlt;
        if (!amountAlt) {
            output.amount = '';
            return;
        }
        getConversionRate(output.currencyAlt).then(function (rate) {
            output.amount = Math.round10(amountAlt / rate, -5).toString();
        });
    };

    /**
     * Convert amount on passed transaction output from another currency to
     * BTC.
     *
     * Fills the `amount` property on the passed tx output object.
     *
     * convertToAltCurrency -> changes parameter directly
     * convertToAltCurrencyToCopied -> returns a copy with changed object
     *
     * @param {Object} output  Output in format:
     *              {amount: String, amountAlt: String, currencyAlt: String...}
     * @return {Promise}       Fulfilled when finished
     */
    $scope.convertToAltCurrency = function (output) {

        var currency = getConversionRate(output.currencyAlt||DEFAULT_ALT_CURRENCY)
        //convertToAltCurrencyToCopied does not convert input, only returns a copy
        //so we need to copy it back
        convertToAltCurrencyToCopied(output,currency).then(function(copied){
            _copyOutputFrom(copied,output)
        })
    };

    /**
     * Convert amount on passed transaction output from another currency to
     * BTC and returns the copy
     *
     * Fills the `amount` property on the passed tx output object.
     *
     * convertToAltCurrency -> changes parameter directly
     * convertToAltCurrencyToCopied -> returns a copy with changed object
     *
     * @param {Object} output  Output in format:
     *              {amount: String, amountAlt: String, currencyAlt: String...}
     *                currency: promise for currency
     * @return {Promise}       Fulfilled when finished
     */
    function convertToAltCurrencyToCopied(output, currency) {
        var copiedOutput=_deepCopyOutput(output);


        copiedOutput.currencyAlt =
                    copiedOutput.currencyAlt || DEFAULT_ALT_CURRENCY;


        var amount = +copiedOutput.amount;
        if (!amount) {
            copiedOutput.amountAlt = '';
            return $q.when(copiedOutput)
        } else {
            return currency.then(function (rate) {
            //return getConversionRate(copiedOutput.currencyAlt).then(function (rate) {
                copiedOutput.amountAlt = Math.round10(amount * rate, -2).toString();
                return copiedOutput;
            });
        }
    }

    /**
     * Get conversion rate between BTC and passed currency.
     *
     * @param {String} currency  Currency abbreviation; example: "USD"
     * @return {Float}           Convertsion rate
     */
    function getConversionRate(currency) {
        $log.log("Getting conversion rate for currency "+currency)
        var url = [
            'https://api.coindesk.com/v1/bpi/currentprice/',
            currency,
            '.json'
        ].join('');
        return $http.get(url).then(function (res) {
            var rate = res.data.bpi[currency].rate_float;
            $log.log("Conversion rate for currency "+currency+" is "+rate)
            return rate;
        });
    }

    /**
     * Get all currencies that we are able to convert to and from BTC.
     *
     * The list of currencies is cached.  The API is polled only once.
     *
     * @return {Promise}  Resolved with an Array of currency abbrevs.
     *                    Example: ["USD", "GBP"...]
     */
    function getSupportedAltCurrencies() {
        var url;
        if (_supportedAltCurrenciesCache === null) {
            url = 'https://api.coindesk.com/v1/bpi/supported-currencies.json';
            return $http.get(url).then(function (res) {
                _supportedAltCurrenciesCache =
                    res.data.map(function (currency) {
                        return currency.currency;
                    });
                return _supportedAltCurrenciesCache;
            });
        }
        return $q.when(_supportedAltCurrenciesCache);
    }

});
